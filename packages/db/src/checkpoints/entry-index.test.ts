import { expect, test } from "bun:test";
import { mkdtemp, readdir, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CheckpointArchiveEntry,
  canonicalJson,
  validateCheckpointEntryGraph,
} from "@pstdio/pocketcoder-contracts";
import { createCheckpointEntryIndex } from "./entry-index";

const directory = (mount: number, path: string): CheckpointArchiveEntry => ({
  mount,
  path,
  kind: "directory",
  size: 0,
  mode: 0o700,
  mtime_ns: "0",
});

async function fixture(maxBytes = 1_000_000, signal?: AbortSignal) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc-entry-index-")));
  const index = createCheckpointEntryIndex(root, { maxBytes, signal, check() {} });
  return {
    root,
    index,
    async close() {
      try {
        await index.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

test("keeps ordered metadata on anonymous disk files and looks up exact mount and UTF-8 names", async () => {
  const f = await fixture();
  const records = [directory(0, "a"), directory(0, "\uE000"), directory(0, "\u{10000}"), directory(1, "a")];
  try {
    for (const entry of records) await f.index.append(entry);
    expect(await readdir(f.root)).toEqual([]);
    const sealed = f.index.seal();
    for (const entry of records) expect(await sealed.lookup(entry.mount, entry.path)).toEqual(entry);
    expect(await sealed.lookup(0, "absent")).toBeNull();
    expect(await sealed.lookup(2, "a")).toBeNull();
    const received = [];
    for await (const entry of sealed.entries()) received.push(entry);
    expect(received).toEqual(records);
    expect(f.index.bytes).toBe(records.reduce((sum, entry) => sum + 12 + Buffer.byteLength(canonicalJson(entry)), 0));
    await expect(f.index.append(directory(2, "a"))).rejects.toThrow("sealed");
  } finally {
    await f.close();
  }
});

test("refuses duplicate and out-of-order records before changing the disk index", async () => {
  const f = await fixture();
  try {
    await f.index.append(directory(0, "b"));
    const bytes = f.index.bytes;
    await expect(f.index.append(directory(0, "b"))).rejects.toThrow("order");
    await expect(f.index.append(directory(0, "a"))).rejects.toThrow("order");
    expect(f.index.bytes).toBe(bytes);
    expect(await f.index.seal().lookup(0, "b")).toEqual(directory(0, "b"));
  } finally {
    await f.close();
  }
});

test("counts record framing and offsets against the admitted physical byte budget", async () => {
  const entry = directory(0, "a");
  const budget = 12 + Buffer.byteLength(canonicalJson(entry));
  const f = await fixture(budget);
  try {
    await f.index.append(entry);
    await expect(f.index.append(directory(0, "b"))).rejects.toThrow("reservation");
    expect(f.index.bytes).toBe(budget);
    expect(await f.index.seal().lookup(0, "b")).toBeNull();
  } finally {
    await f.close();
  }
});

test("rejects reads after a real staging-parent replacement and closes the original anonymous files", async () => {
  const f = await fixture();
  const moved = `${f.root}-original`;
  try {
    await f.index.append(directory(0, "a"));
    const sealed = f.index.seal();
    await rename(f.root, moved);
    await expect(sealed.lookup(0, "a")).rejects.toThrow();
    await expect(f.index.close()).rejects.toThrow();
    expect(await readdir(moved)).toEqual([]);
    await expect(sealed.lookup(0, "a")).rejects.toThrow("closed");
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(moved, { recursive: true, force: true });
  }
});

test("an abort stops indexed work without retaining any named scratch file", async () => {
  const abort = new AbortController();
  const f = await fixture(1_000_000, abort.signal);
  try {
    await f.index.append(directory(0, "a"));
    const sealed = f.index.seal();
    abort.abort(new Error("checkpoint transfer fenced"));
    await expect(sealed.lookup(0, "a")).rejects.toThrow("fenced");
    expect(await readdir(f.root)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("graph checks use the complete immutable disk index", async () => {
  const f = await fixture();
  const alias: CheckpointArchiveEntry = {
    mount: 0,
    path: "alias/content",
    kind: "directory",
    size: 0,
    mode: 0o700,
    mtime_ns: "0",
  };
  try {
    await f.index.append(alias);
    await f.index.append(directory(0, "real"));
    const sealed = f.index.seal();
    await expect(validateCheckpointEntryGraph(alias, sealed.lookup)).rejects.toThrow("parent");
  } finally {
    await f.close();
  }
});

test("large indexed work yields to timers and cancellation", async () => {
  const abort = new AbortController();
  const f = await fixture(1_000_000, abort.signal);
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
  }, 1);
  try {
    for (let index = 0; index < 1000; index++)
      await f.index.append(directory(0, `entry-${String(index).padStart(8, "0")}`));
    const sealed = f.index.seal();
    let entries = 0;
    for await (const _entry of sealed.entries()) entries++;
    expect(entries).toBe(1000);
    expect(ticks).toBeGreaterThan(0);
    const canceled = setTimeout(() => abort.abort(new Error("timer fence")), 0);
    try {
      await expect(
        (async () => {
          for await (const entry of sealed.entries()) await sealed.lookup(entry.mount, entry.path);
        })(),
      ).rejects.toThrow("timer fence");
    } finally {
      clearTimeout(canceled);
    }
  } finally {
    clearInterval(timer);
    await f.close();
  }
});

test("closing at an append yield prevents later writes and refuses sealing unfinished work", async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 63; index++) await f.index.append(directory(0, String(index).padStart(4, "0")));
    const pending = f.index.append(directory(0, "0063")).then(
      () => "resolved",
      (error: Error) => error.message,
    );
    expect(() => f.index.seal()).toThrow("still running");
    await f.index.close();
    expect(await pending).toContain("closed");
    expect(await readdir(f.root)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("sealed ordinal and reverse reads retain exact order and refuse after close", async () => {
  const f = await fixture();
  const records = [directory(0, "a"), directory(0, "a/b"), directory(1, "☃")];
  try {
    for (const entry of records) await f.index.append(entry);
    const sealed = f.index.seal();
    expect(await sealed.ordinal(0, "a/b")).toBe(1);
    expect(await sealed.ordinal(0, "missing")).toBeNull();
    expect(await sealed.entryAt(2)).toEqual(directory(1, "☃"));
    await expect(sealed.entryAt(-1)).rejects.toThrow("ordinal");
    await expect(sealed.entryAt(3)).rejects.toThrow("ordinal");
    const reverse = [];
    for await (const entry of sealed.entries({ reverse: true })) reverse.push(entry);
    expect(reverse).toEqual([...records].reverse());
    await f.index.close();
    await expect(sealed.entryAt(0)).rejects.toThrow("closed");
    await expect(sealed.ordinal(0, "a")).rejects.toThrow("closed");
  } finally {
    await f.close();
  }
});

test("reverse iteration rechecks ownership before its final EOF", async () => {
  const f = await fixture();
  try {
    await f.index.append(directory(0, "a"));
    const reader = f.index.seal().entries({ reverse: true });
    expect((await reader.next()).value).toEqual(directory(0, "a"));
    await f.index.close();
    await expect(reader.next()).rejects.toThrow("closed");
  } finally {
    await f.close();
  }
});
