import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CheckpointArchiveEntry, canonicalJson } from "@pstdio/pocketcoder-contracts";
import { createCheckpointEntrySorter } from "./entry-sort";

const entry = (mount: number, path: string): CheckpointArchiveEntry => ({
  mount,
  path,
  kind: "directory",
  size: 0,
  mode: 0o700,
  mtime_ns: "0",
});
async function fixture(maxBytes = 1_000_000, signal?: AbortSignal) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc-entry-sort-")));
  const sorter = createCheckpointEntrySorter(root, { maxBytes, signal, check() {} });
  return {
    root,
    sorter,
    async close() {
      try {
        await sorter.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

test("sorts unsorted records on disk by mount and raw UTF-8 bytes with exact lookup", async () => {
  const f = await fixture();
  const records = [entry(1, "a"), entry(0, "\u{10000}"), entry(0, "a"), entry(0, "\uE000"), entry(0, "z")] as const;
  try {
    for (const record of records) await f.sorter.append(record);
    const sorted = await f.sorter.seal();
    const received = [];
    for await (const record of sorted.entries()) received.push(record);
    expect(received).toEqual([records[2], records[4], records[3], records[1], records[0]]);
    for (const record of records) expect(await sorted.lookup(record.mount, record.path)).toEqual(record);
    expect(await sorted.lookup(2, "a")).toBeNull();
    expect(await readdir(f.root)).toEqual([]);
    expect(f.sorter.bytes).toBe(
      records.reduce((sum, record) => sum + 12 + Buffer.byteLength(canonicalJson(record)), 0),
    );
    expect(f.sorter.peakBytes).toBe(f.sorter.bytes + records.length * 8);
    await expect(f.sorter.append(entry(2, "a"))).rejects.toThrow("sealed");
  } finally {
    await f.close();
  }
});

test("finds duplicate keys across separate merge runs", async () => {
  const f = await fixture();
  try {
    for (const path of ["duplicate", "a", "z", "b", "duplicate"]) await f.sorter.append(entry(0, path));
    await expect(f.sorter.seal()).rejects.toThrow("duplicate");
    await expect(f.sorter.append(entry(0, "more"))).rejects.toThrow();
    expect(await readdir(f.root)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("reserves both offset tables before accepting merge work", async () => {
  const records = [entry(0, "z"), entry(0, "a")] as const;
  const budget = records.reduce((sum, record) => sum + 20 + Buffer.byteLength(canonicalJson(record)), 0);
  const f = await fixture(budget);
  try {
    for (const record of records) await f.sorter.append(record);
    await expect(f.sorter.append(entry(0, "b"))).rejects.toThrow("reservation");
    const sorted = await f.sorter.seal();
    expect(await sorted.lookup(0, "a")).toEqual(records[1]);
    expect(f.sorter.peakBytes).toBe(budget);
  } finally {
    await f.close();
  }
});

test("empty and single-entry sorts need no merge offset table", async () => {
  for (const count of [0, 1]) {
    const record = entry(0, "a");
    const budget = count * (12 + Buffer.byteLength(canonicalJson(record)));
    const f = await fixture(budget);
    try {
      if (count) await f.sorter.append(record);
      const sorted = await f.sorter.seal();
      expect(sorted.count).toBe(count);
      expect(f.sorter.bytes).toBe(budget);
      expect(f.sorter.peakBytes).toBe(budget);
    } finally {
      await f.close();
    }
  }
});

test("merge work yields so a real timer can cancel it", async () => {
  const abort = new AbortController();
  const f = await fixture(1_000_000, abort.signal);
  try {
    for (let index = 200; index >= 0; index--) await f.sorter.append(entry(0, String(index).padStart(8, "0")));
    const timer = setTimeout(() => abort.abort(new Error("sort transfer fenced")), 0);
    try {
      await expect(f.sorter.seal()).rejects.toThrow("sort transfer fenced");
    } finally {
      clearTimeout(timer);
    }
    expect(await readdir(f.root)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("closing an active merge invalidates later IO and drains its owned descriptors", async () => {
  const f = await fixture();
  try {
    for (let index = 100; index >= 0; index--) await f.sorter.append(entry(0, String(index).padStart(8, "0")));
    const result = f.sorter.seal().then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await f.sorter.close();
    expect(await result).toContain("closed");
    expect(await readdir(f.root)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("repeated merge passes keep native descriptor custody bounded and close every owned file", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc-sort-descriptors-")));
  const baseline = readdirSync("/dev/fd").length;
  let peak = baseline;
  const sorter = createCheckpointEntrySorter(root, {
    maxBytes: 1_000_000,
    check() {
      peak = Math.max(peak, readdirSync("/dev/fd").length);
    },
  });
  try {
    for (let index = 32; index >= 0; index--) await sorter.append(entry(0, String(index).padStart(8, "0")));
    const sorted = await sorter.seal();
    expect(sorted.count).toBe(33);
    // Each of the three scratch files owns one file and one parent descriptor.
    expect(peak - baseline).toBe(6);
    await sorter.close();
    expect(readdirSync("/dev/fd").length).toBe(baseline);
  } finally {
    await sorter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("revoked capture authority still drains and closes its own anonymous sort files", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc-revoked-sort-")));
  const baseline = readdirSync("/dev/fd").length;
  const abort = new AbortController();
  const sorter = createCheckpointEntrySorter(root, {
    maxBytes: 1_000_000,
    signal: abort.signal,
    check: () => abort.signal.throwIfAborted(),
  });
  try {
    await sorter.append(entry(0, "saved"));
    await sorter.seal();
    abort.abort(new Error("capture authority revoked"));
    await sorter.close();
    expect(readdirSync("/dev/fd").length).toBe(baseline);
    expect(await readdir(root)).toEqual([]);
  } finally {
    await sorter.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
