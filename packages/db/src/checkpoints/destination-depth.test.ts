import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckpointArchiveEntry } from "@pstdio/pocketcoder-contracts";
import { createCheckpointDestination } from "./destination";
import { createCheckpointEntryIndex } from "./entry-index";

async function fixture(depth: number) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc-destination-deep-")));
  const parent = join(root, "parent");
  const directory = join(root, "scratch");
  await mkdir(parent, { mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  const payload = Buffer.from("payload");
  const entries: CheckpointArchiveEntry[] = [];
  let path = "";
  for (let index = 0; index < depth; index++) {
    path = path ? `${path}/child` : "child";
    entries.push({ kind: "directory", mount: 0, path, mode: 0, mtime_ns: "1730000000123456789", size: 0 });
  }
  const fileEntry: CheckpointArchiveEntry = {
    kind: "file",
    mount: 0,
    path: `${path}/file`,
    mode: 0,
    mtime_ns: "1730000000123456789",
    size: payload.length,
    digest: `sha256:${createHash("sha256").update(payload).digest("hex")}`,
  };
  entries.push(fileEntry);
  const index = createCheckpointEntryIndex(directory, { maxBytes: 1_000_000, check() {} });
  for (const entry of entries) await index.append(entry);
  return {
    root,
    parent,
    directory,
    payload,
    entries,
    fileEntry,
    index,
    complete: index.seal(),
    mounts: [{ parent, policy: { name: "worktree", target: "/workspace", maxFiles: 10_000_000, maxBytes: 7 } }],
  };
}
test("deep restrictive extraction keeps a constant descriptor budget and cleans every owned inode", async () => {
  const f = await fixture(35);
  const baseline = readdirSync("/dev/fd").length;
  let peak = baseline;
  let destination: Awaited<ReturnType<typeof createCheckpointDestination>> | undefined;
  try {
    destination = await createCheckpointDestination(f.mounts, f.complete, {
      directory: f.directory,
      maxCustodyBytes: 1_000_000,
      check() {
        peak = Math.max(peak, readdirSync("/dev/fd").length);
      },
    });
    for (const entry of f.entries) if (entry.kind === "directory") await destination.createDirectory(entry);
    const file = await destination.openFile(f.fileEntry);
    await file.write(f.payload);
    await file.finish();
    await destination.census();
    for (const entry of f.entries.toReversed())
      if (entry.kind === "directory") await destination.finalizeDirectory(entry);
    await destination.preparedMounts();
    expect(peak).toBeLessThanOrEqual(baseline + 16);
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
test("the last parent callback cannot replace an already closed intermediate native ancestor", async () => {
  const f = await fixture(3);
  let destination: Awaited<ReturnType<typeof createCheckpointDestination>> | undefined;
  let armed = false;
  let count = 0;
  let changed = false;
  try {
    destination = await createCheckpointDestination(f.mounts, f.complete, {
      directory: f.directory,
      maxCustodyBytes: 1_000_000,
      check() {
        if (!armed || ++count !== 5) return;
        const stage = readdirSync(f.parent)[0];
        if (!stage) throw new Error("Missing actual stage.");
        const outer = join(f.parent, stage, "child");
        renameSync(join(outer, "child"), join(outer, "held"));
        mkdirSync(join(outer, "child"));
        writeFileSync(join(outer, "child", "foreign"), "untouched");
        changed = true;
      },
    });
    for (const entry of f.entries) if (entry.kind === "directory") await destination.createDirectory(entry);
    armed = true;
    await expect(destination.openFile(f.fileEntry)).rejects.toThrow();
    expect(changed).toBe(true);
    await expect(destination.close()).rejects.toThrow();
    const stage = readdirSync(f.parent)[0];
    if (!stage) throw new Error("Quarantined stage missing.");
    expect(readFileSync(join(f.parent, stage, "child", "child", "foreign"), "utf8")).toBe("untouched");
  } finally {
    await destination?.close().catch(() => {});
    await f.index.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
