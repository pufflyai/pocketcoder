import { expect, test } from "bun:test";
import { closeSync, constants, fstatSync, openSync, readdirSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trackCheckpointFiles } from "@pstdio/pocketcoder-testkit";
import { createCheckpointDirectoryQueue } from "./directory-queue";
import { unrelatedFilesFixture } from "./unrelated-files-fixture";

const record = (path: string, mount = 0) => ({ mount, path, custody: Buffer.alloc(64, mount + 1) });
async function fixture(maxBytes = 1_000_000, signal?: AbortSignal) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc-directory-queue-")));
  const owned = trackCheckpointFiles(root);
  const queue = createCheckpointDirectoryQueue(root, { maxBytes, signal, check() {} });
  return {
    root,
    queue,
    owned,
    async close() {
      try {
        await queue.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

test("disk FIFO accepts root and Unicode paths and appends while draining", async () => {
  const f = await fixture();
  try {
    const root = record("");
    const first = record("parent/é", 15);
    const later = record("parent/child");
    await f.queue.append(root);
    await f.queue.append(first);
    expect(f.queue.count).toBe(2);
    expect(await f.queue.take()).toEqual(root);
    await f.queue.append(later);
    expect(await f.queue.take()).toEqual(first);
    expect(await f.queue.take()).toEqual(later);
    expect(await f.queue.take()).toBeNull();
    expect(f.queue.count).toBe(0);
    await f.queue.append(root);
    expect(await f.queue.take()).toEqual(root);
    expect(readdirSync(f.root)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("exact physical reservation remains charged after records are consumed", async () => {
  const first = record("a");
  const second = record("é");
  const bytes = 2 * (4 + 1 + 64) + Buffer.byteLength(first.path) + Buffer.byteLength(second.path);
  const f = await fixture(bytes);
  try {
    await f.queue.append(first);
    await f.queue.append(second);
    expect(f.queue.bytes).toBe(bytes);
    await f.queue.take();
    await f.queue.take();
    expect(f.queue.bytes).toBe(bytes);
    const anonymous = f.owned.files();
    expect(anonymous).toHaveLength(1);
    expect(anonymous[0]?.stat.size).toBe(BigInt(bytes));
    await expect(f.queue.append(first)).rejects.toThrow("reservation");
    expect(f.queue.bytes).toBe(bytes);
    expect(f.queue.count).toBe(0);
    expect(await f.queue.take()).toBeNull();
  } finally {
    await f.close();
  }
});

test("bounded records refuse unsafe paths, mounts and custody before writing", async () => {
  const f = await fixture(100_000);
  try {
    for (const path of ["/absolute", "../escape", "dot/./part", "double//part", "back\\slash", "\ud800"])
      await expect(f.queue.append(record(path))).rejects.toThrow("record");
    for (const mount of [-1, 16, 1.5]) await expect(f.queue.append(record("safe", mount))).rejects.toThrow("record");
    for (const size of [63, 65])
      await expect(f.queue.append({ ...record("safe"), custody: Buffer.alloc(size) })).rejects.toThrow("record");
    await expect(f.queue.append(record("x".repeat(16_384 - 65 + 1)))).rejects.toThrow("record");
    expect(f.queue.bytes).toBe(0);
    expect(f.queue.count).toBe(0);
    const maximum = record("x".repeat(16_384 - 65));
    await f.queue.append(maximum);
    expect(f.queue.bytes).toBe(4 + 16_384);
    expect(await f.queue.take()).toEqual(maximum);
  } finally {
    await f.close();
  }
});

test("custody is opaque disk data detached from caller and returned buffers", async () => {
  const f = await fixture();
  try {
    const value = record("same");
    const expected = Buffer.from(value.custody);
    await f.queue.append(value);
    value.custody.fill(255);
    const taken = await f.queue.take();
    expect(taken?.custody).toEqual(expected);
    taken?.custody.fill(0);
    await f.queue.append({ ...value, custody: expected });
    expect((await f.queue.take())?.custody).toEqual(expected);
  } finally {
    await f.close();
  }
});

test("wide FIFO keeps one file and one held parent regardless of pending count", async () => {
  const f = await fixture();
  const live = f.owned.snapshot().length;
  expect(live).toBe(2);
  try {
    for (let index = 0; index < 512; index++) {
      await f.queue.append(record(`dir-${index}`));
      expect(f.owned.snapshot()).toHaveLength(live);
    }
    expect(f.queue.count).toBe(512);
    for (let index = 0; index < 512; index++) expect((await f.queue.take())?.path).toBe(`dir-${index}`);
    expect(f.queue.count).toBe(0);
    await f.queue.close();
    expect(f.owned.snapshot()).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("real timer abort interrupts draining and close releases native custody", async () => {
  const abort = new AbortController();
  const f = await fixture(1_000_000, abort.signal);
  const live = f.owned.snapshot().length;
  expect(live).toBe(2);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    for (let index = 0; index < 200; index++) await f.queue.append(record(`dir-${index}`));
    timer = setTimeout(() => abort.abort(new Error("directory transfer fenced")), 0);
    const draining = (async () => {
      while (await f.queue.take()) {}
    })();
    await expect(draining).rejects.toThrow("directory transfer fenced");
    expect(f.queue.count).toBeGreaterThan(0);
    await f.queue.close();
    expect(f.owned.snapshot()).toHaveLength(0);
  } finally {
    clearTimeout(timer);
    await f.close();
  }
});

test("close invalidates pending work and cannot revive or close a reused descriptor", async () => {
  const f = await fixture();
  const live = f.owned.snapshot().length;
  expect(live).toBe(2);
  try {
    const appending = f.queue.append(record("pending"));
    void appending.catch(() => {});
    await f.queue.close();
    await expect(appending).rejects.toThrow("closed");
    expect(f.owned.snapshot()).toHaveLength(0);
    const replacement = openSync(f.root, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await expect(f.queue.take()).rejects.toThrow("closed");
      await f.queue.close();
      expect(fstatSync(replacement).isDirectory()).toBe(true);
    } finally {
      closeSync(replacement);
    }
  } finally {
    await f.close();
  }
});

test("concurrent operations refuse without building a second in-memory work queue", async () => {
  const f = await fixture();
  try {
    const first = f.queue.append(record("first"));
    await expect(f.queue.append(record("second"))).rejects.toThrow("already running");
    await first;
    expect(f.queue.count).toBe(1);
    expect((await f.queue.take())?.path).toBe("first");
    expect(await f.queue.take()).toBeNull();
  } finally {
    await f.close();
  }
});

test("constructor refuses invalid reservation, prior abort and failed custody without native leaks", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc-directory-queue-invalid-")));
  const owned = trackCheckpointFiles(root);
  try {
    for (const maxBytes of [-1, Infinity, 1.5])
      expect(() => createCheckpointDirectoryQueue(root, { maxBytes, check() {} })).toThrow("reservation");
    const abort = new AbortController();
    abort.abort(new Error("already fenced"));
    expect(() => createCheckpointDirectoryQueue(root, { maxBytes: 100, signal: abort.signal, check() {} })).toThrow(
      "already fenced",
    );
    expect(() =>
      createCheckpointDirectoryQueue(root, {
        maxBytes: 100,
        check() {
          throw new Error("custody refused");
        },
      }),
    ).toThrow("custody refused");
    expect(owned.snapshot()).toHaveLength(0);
    expect(readdirSync(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an abort after the real prefix write still charges its physical bytes", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc-directory-queue-partial-")));
  const owned = trackCheckpointFiles(root);
  const abort = new AbortController();
  let armed = false;
  const queue = createCheckpointDirectoryQueue(root, {
    maxBytes: 100,
    signal: abort.signal,
    check() {
      if (!armed) return;
      if (owned.files().some(({ stat }) => stat.size === 4n)) {
        armed = false;
        abort.abort(new Error("prefix write fenced"));
      }
    },
  });
  try {
    expect(owned.snapshot()).toHaveLength(2);
    armed = true;
    await expect(queue.append(record("x"))).rejects.toThrow("prefix write fenced");
    expect(queue.bytes).toBe(4);
    expect(queue.count).toBe(0);
    await queue.close();
    expect(owned.snapshot()).toHaveLength(0);
  } finally {
    await queue.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("abort during actual anonymous-file construction releases both descriptors synchronously", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc-directory-queue-construct-")));
  const owned = trackCheckpointFiles(root);
  const abort = new AbortController();
  let checks = 0;
  try {
    expect(() =>
      createCheckpointDirectoryQueue(root, {
        maxBytes: 100,
        signal: abort.signal,
        check() {
          if (++checks === 2) abort.abort(new Error("construction fenced"));
        },
      }),
    ).toThrow("construction fenced");
    expect(owned.snapshot()).toHaveLength(0);
    expect(readdirSync(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

unrelatedFilesFixture();
