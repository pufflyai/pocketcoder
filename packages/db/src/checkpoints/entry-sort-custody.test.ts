import { expect, test } from "bun:test";
import { lstatSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CheckpointArchiveEntry, canonicalJson } from "@pstdio/pocketcoder-contracts";
import { createCheckpointEntrySorter } from "./entry-sort";
import { checkpointCustody } from "./source-custody";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc-sort-custody-")));
  await mkdir(join(root, "stage"), { mode: 0o700 });
  const records = [];
  for (const path of ["z", "a"]) {
    await mkdir(join(root, path));
    const stat = lstatSync(join(root, path), { bigint: true });
    const entry: CheckpointArchiveEntry = {
      mount: 0,
      path,
      kind: "directory",
      mode: Number(stat.mode & 0o777n),
      mtime_ns: String(stat.mtimeNs),
      size: 0,
    };
    records.push({ entry, custody: checkpointCustody(stat) });
  }
  const budget = records.reduce((sum, record) => sum + 84 + Buffer.byteLength(canonicalJson(record.entry)), 0);
  const sorter = createCheckpointEntrySorter(join(root, "stage"), { maxBytes: budget, check() {} });
  return {
    root,
    records,
    budget,
    sorter,
    async close() {
      await sorter.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("sorting retains native custody beside entries without putting it in the archive entry", async () => {
  const f = await fixture();
  try {
    for (const record of f.records) await f.sorter.append(record.entry, record.custody);
    const complete = await f.sorter.seal();
    for (const record of f.records) expect(await complete.lookupRecord(0, record.entry.path)).toEqual(record);
    const received = [];
    for await (const record of complete.records()) received.push(record);
    expect(received.map((record) => record.entry.path)).toEqual(["a", "z"]);
    expect(await complete.lookup(0, "a")).toEqual(f.records[1]?.entry ?? null);
    expect(await complete.lookupRecord(1, "a")).toBeNull();
    expect(f.sorter.peakBytes).toBe(f.budget);
    const wireEntries = [];
    for await (const entry of complete.entries()) wireEntries.push(entry);
    expect(wireEntries.every((entry) => !("custody" in entry))).toBe(true);
  } finally {
    await f.close();
  }
});

test("private custody is copied to owned disk and must be exactly 64 bytes", async () => {
  const f = await fixture();
  const record = f.records[0];
  if (!record) throw new Error("Expected actual directory record");
  const expected = Buffer.from(record.custody);
  try {
    await expect(f.sorter.append(record.entry, Buffer.alloc(63))).rejects.toThrow("custody");
    await f.sorter.append(record.entry, record.custody);
    record.custody.fill(0);
    const complete = await f.sorter.seal();
    expect((await complete.lookupRecord(0, record.entry.path))?.custody).toEqual(expected);
    expect(f.sorter.bytes).toBe(76 + Buffer.byteLength(canonicalJson(record.entry)));
  } finally {
    await f.close();
  }
});
