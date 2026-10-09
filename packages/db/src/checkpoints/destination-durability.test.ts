import { expect, test } from "bun:test";
import { fstatSync, fsyncSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckpointArchiveEntry } from "@pstdio/pocketcoder-contracts";
import { createDestinationCustody } from "./destination-custody";
import { createDestinationDirectories, openDestinationParents } from "./destination-directory";
import { finalizeDestinationDirectory } from "./destination-finalize";
import { createDestinationInventory } from "./destination-inventory";
import { destinationMkdir, destinationStat } from "./destination-native";
import { createCheckpointEntryIndex } from "./entry-index";

async function fixture(entries: CheckpointArchiveEntry[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc-destination-durability-")));
  const parent = join(root, "parent");
  const scratch = join(root, "scratch");
  await mkdir(parent, { mode: 0o700 });
  await mkdir(scratch, { mode: 0o700 });
  const index = createCheckpointEntryIndex(scratch, { maxBytes: 100000, check() {} });
  for (const entry of entries) await index.append(entry);
  const ledger = await createDestinationCustody(scratch, index.seal(), 100000, () => {});
  const mounts = [
    { parent, policy: { name: "worktree", target: "/workspace", maxBytes: 0, maxFiles: entries.length } },
  ];
  const parents = openDestinationParents(mounts);
  const directories = createDestinationDirectories(mounts, parents, ledger, () => {});
  directories.createStages();
  return {
    ledger,
    directories,
    parents,
    async close() {
      try {
        await createDestinationInventory(ledger, directories).remove();
      } finally {
        directories.closeDescriptors();
        await ledger.close();
        await index.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

test("final directory flush observes its exact final restrictive metadata on the still-held child", async () => {
  const entry: CheckpointArchiveEntry = {
    mount: 0,
    path: "dir",
    kind: "directory",
    size: 0,
    mode: 0,
    mtime_ns: "1730000000123456789",
  };
  const f = await fixture([entry]);
  try {
    const parent = await f.directories.openParent(entry);
    try {
      destinationMkdir(parent.descriptor, parent.name);
      parent.refresh();
      f.ledger.retain(0, destinationStat(parent.descriptor, parent.name), 2);
    } finally {
      parent.close();
    }
    const observed: { mode: bigint; time: bigint }[] = [];
    await finalizeDestinationDirectory(entry, f.ledger, f.directories, (descriptor) => {
      fsyncSync(descriptor);
      const stat = fstatSync(descriptor, { bigint: true });
      observed.push({ mode: stat.mode & 0o777n, time: stat.mtimeNs });
    });
    expect(observed.at(-1)).toEqual({ mode: 0n, time: BigInt(entry.mtime_ns) });
  } finally {
    await f.close();
  }
});

test("empty stage roots flush before their private parent namespace with held custody checks", async () => {
  const f = await fixture([]);
  try {
    const observed: bigint[] = [];
    f.directories.sync((descriptor: number) => {
      fsyncSync(descriptor);
      observed.push(fstatSync(descriptor, { bigint: true }).ino);
    });
    expect(observed).toEqual([
      ...f.directories.stages.map((stage) => fstatSync(stage.descriptor, { bigint: true }).ino),
      ...[...f.parents.values()].map((parent) => fstatSync(parent.descriptor, { bigint: true }).ino),
    ]);
  } finally {
    await f.close();
  }
});
