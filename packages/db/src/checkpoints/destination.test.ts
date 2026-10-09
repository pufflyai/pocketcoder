import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckpointArchiveEntry } from "@pstdio/pocketcoder-contracts";
import { createCheckpointDestination } from "./destination";
import { createCheckpointEntryIndex } from "./entry-index";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc-destination-")));
  const parent = join(root, "parent");
  const directory = join(root, "scratch");
  await mkdir(parent, { mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  const stamp = "1730000000123456789";
  const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
  const entries: CheckpointArchiveEntry[] = [
    { mount: 0, path: "dir", kind: "directory", size: 0, mode: 0, mtime_ns: stamp },
    { mount: 0, path: "dir/content", kind: "file", size: 7, digest: digest("content"), mode: 0o400, mtime_ns: stamp },
    { mount: 0, path: "dir/empty", kind: "file", size: 0, digest: digest(""), mode: 0, mtime_ns: stamp },
    {
      mount: 0,
      path: "link",
      kind: "symlink",
      link_target: "dir/content",
      size: 11,
      digest: digest("dir/content"),
      mode: 0o777,
      mtime_ns: stamp,
    },
  ];
  const index = createCheckpointEntryIndex(directory, { maxBytes: 1_000_000, check() {} });
  for (const entry of entries) await index.append(entry);
  const complete = index.seal();
  return {
    root,
    parent,
    directory,
    entries,
    index,
    complete,
    stamp,
    mounts: [{ parent, policy: { name: "worktree", target: "/workspace", maxBytes: 18, maxFiles: 4 } }],
    options: { directory, maxCustodyBytes: 1_000_000, check() {} },
  };
}

test("native destination seals actual content and cleans restrictive modes after the source index closes", async () => {
  const f = await fixture();
  const baseline = readdirSync("/dev/fd").length;
  let destination: Awaited<ReturnType<typeof createCheckpointDestination>> | undefined;
  try {
    destination = await createCheckpointDestination(f.mounts, f.complete, f.options);
    await destination.createDirectory(f.entries[0]!);
    const file = await destination.openFile(f.entries[1]!);
    await file.write(Buffer.from("content"));
    await file.finish();
    const empty = await destination.openFile(f.entries[2]!);
    await empty.finish();
    await destination.createLink(f.entries[3]!);
    const unsealed = readdirSync(f.parent)[0]!;
    expect(readFileSync(join(f.parent, unsealed, "dir/content"), "utf8")).toBe("content");
    await destination.census();
    await destination.finalizeDirectory(f.entries[0]!);
    const mounts = await destination.preparedMounts();
    const stage = mounts[0]!.path;
    expect(lstatSync(join(stage, "dir"), { bigint: true }).mtimeNs).toBe(BigInt(f.stamp));
    expect(lstatSync(join(stage, "dir")).mode & 0o777).toBe(0);
    expect(readlinkSync(join(stage, "link"))).toBe("dir/content");
    await f.index.close();
    await destination.close();
    expect(readdirSync(f.parent)).toEqual([]);
    expect(readdirSync(f.directory)).toEqual([]);
    expect(readdirSync("/dev/fd").length).toBe(baseline - 4);
  } finally {
    await destination?.close().catch(() => {});
    await f.index.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("destination refuses actual unknown siblings and keeps their bytes during close", async () => {
  const f = await fixture();
  let destination: Awaited<ReturnType<typeof createCheckpointDestination>> | undefined;
  try {
    destination = await createCheckpointDestination(f.mounts, f.complete, f.options);
    const stage = readdirSync(f.parent)[0]!;
    writeFileSync(join(f.parent, stage, "foreign"), "keep me");
    await expect(destination.census()).rejects.toThrow();
    await expect(destination.close()).rejects.toThrow();
    expect(readFileSync(join(f.parent, stage, "foreign"), "utf8")).toBe("keep me");
  } finally {
    await destination?.close().catch(() => {});
    await f.index.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
