import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CheckpointArchiveEntry,
  readCheckpointArchive,
  writeCheckpointArchive,
} from "@pstdio/pocketcoder-contracts";
import { createVerifiedCheckpointArchive } from "./verified-archive";

const digest = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const dir = (path: string): CheckpointArchiveEntry => ({
  mount: 0,
  path,
  kind: "directory",
  size: 0,
  mode: 448,
  mtime_ns: "0",
});
const link = (path: string, target: string): CheckpointArchiveEntry => ({
  mount: 0,
  path,
  kind: "symlink",
  size: Buffer.byteLength(target),
  mode: 511,
  mtime_ns: "0",
  link_target: target,
  digest: digest(target),
});
async function bytes(entries: CheckpointArchiveEntry[], body = Buffer.alloc(0)) {
  async function* records() {
    for (const entry of entries)
      yield {
        entry,
        payload: entry.kind === "file" ? new Blob([entry.size ? body : Buffer.alloc(0)]).stream() : undefined,
      };
  }
  return Buffer.from(
    await new Response(
      writeCheckpointArchive(
        {
          format: "pocketcoder-checkpoint-tar/v1",
          checkpoint_id: randomUUID(),
          workspace_id: randomUUID(),
          template_digest: digest("template"),
          mounts: [
            { name: "worktree", logical_bytes: entries.reduce((n, e) => n + e.size, 0), file_count: entries.length },
          ],
        },
        records(),
        { maxArchiveBytes: 1_000_000 },
      ),
    ).arrayBuffer(),
  );
}
async function root() {
  return realpath(await mkdtemp(join(tmpdir(), "pc-verified-archive-")));
}
function options(directory: string) {
  return { directory, maxArchiveBytes: 1_000_000, maxIndexBytes: 1_000_000, check() {}, async authorizeHeader() {} };
}

test("verified owner retains exact raw bytes, complete immutable graph and reverse ordinals until close", async () => {
  const directory = await root();
  const body = Buffer.alloc(140_000, 37);
  const records = [
    dir("dir"),
    {
      mount: 0,
      path: "dir/body",
      kind: "file",
      size: body.length,
      mode: 384,
      mtime_ns: "0",
      digest: digest(body),
    } as CheckpointArchiveEntry,
    {
      mount: 0,
      path: "empty",
      kind: "file",
      size: 0,
      mode: 384,
      mtime_ns: "0",
      digest: digest(""),
    } as CheckpointArchiveEntry,
    link("link", "dir/body"),
  ];
  const raw = await bytes(records, body);
  let authorized = false;
  const handle = await createVerifiedCheckpointArchive(new Blob([raw]).stream(), {
    ...options(directory),
    async authorizeHeader() {
      await Bun.sleep(0);
      authorized = true;
    },
  });
  try {
    expect(authorized).toBe(true);
    expect(handle.receipt.entryCount).toBe(4);
    expect(handle.receipt.archiveBytes).toBe(raw.length);
    expect(handle.receipt.archiveDigest).toBe(digest(raw));
    expect(await readdir(directory)).toEqual([]);
    expect(await handle.ordinal(0, "dir/body")).toBe(1);
    const expectedFile = records[1];
    if (!expectedFile) throw new Error("Expected the fixture file record.");
    expect(await handle.entryAt(1)).toEqual(expectedFile);
    expect(Object.isFrozen(await handle.entryAt(1))).toBe(true);
    const reversed = [];
    for await (const entry of handle.entries({ reverse: true })) reversed.push(entry);
    expect(reversed).toEqual([...records].reverse());
    expect(Buffer.from(await new Response(handle.replay()).arrayBuffer())).toEqual(raw);
    const verified = await readCheckpointArchive(handle.replay(), { maxArchiveBytes: raw.length });
    expect(verified.archiveDigest).toBe(handle.receipt.archiveDigest);
    const replay = handle.replay();
    const reader = replay.getReader();
    const pending = reader.read();
    await handle.close(new Error("archive owner closed"));
    await pending.catch(() => {});
    await expect(reader.read()).rejects.toThrow("archive owner closed");
    reader.releaseLock();
    const closed = handle.close();
    expect(handle.close()).toBe(closed);
    await closed;
    await expect(handle.lookup(0, "dir")).rejects.toThrow("closed");
  } finally {
    await handle.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("late cycle, digest and footer refusal never return a prepared owner", async () => {
  const directory = await root();
  const cycle = await bytes([link("a", "b"), link("b", "a")]);
  const content = await bytes(
    [{ mount: 0, path: "file", kind: "file", size: 7, mode: 384, mtime_ns: "0", digest: digest("payload") }],
    Buffer.from("payload"),
  );
  const corrupted = Buffer.from(content);
  corrupted[corrupted.lastIndexOf(Buffer.from("payload"))] = 88;
  const footer = Buffer.from(content);
  footer[footer.length - 1] = 1;
  try {
    for (const [raw, reason] of [
      [cycle, "cycle"],
      [corrupted, "digest"],
      [footer, "end"],
    ] as const) {
      const source = new Blob([raw]).stream();
      await expect(createVerifiedCheckpointArchive(source, options(directory))).rejects.toThrow(reason);
      expect(source.locked).toBe(false);
      expect(await readdir(directory)).toEqual([]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("abort wakes a blocked original input and header rejection preserves the primary error", async () => {
  const directory = await root();
  const abort = new AbortController();
  let canceled = false;
  let pulled = false;
  const source = new ReadableStream<Uint8Array>(
    {
      pull() {
        pulled = true;
      },
      cancel() {
        canceled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const pending = createVerifiedCheckpointArchive(source, { ...options(directory), signal: abort.signal });
  try {
    while (!pulled) await Bun.sleep(0);
    abort.abort(new Error("transfer revoked"));
    await expect(pending).rejects.toThrow("transfer revoked");
    expect(canceled).toBe(true);
    expect(source.locked).toBe(false);
    const incoming = new Blob([await bytes([dir("dir")])]).stream();
    await expect(
      createVerifiedCheckpointArchive(incoming, {
        ...options(directory),
        async authorizeHeader() {
          throw new Error("wrong epoch");
        },
      }),
    ).rejects.toThrow("wrong epoch");
    expect(incoming.locked).toBe(false);
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("abort after verified preparation releases anonymous handles without a replay consumer", async () => {
  const directory = await root();
  const abort = new AbortController();
  const native = await import("node:fs");
  function held() {
    return native.readdirSync("/dev/fd").filter((name) => {
      try {
        const s = native.fstatSync(Number(name));
        return s.isFile() && s.nlink === 0;
      } catch {
        return false;
      }
    }).length;
  }
  const before = held();
  const handle = await createVerifiedCheckpointArchive(new Blob([await bytes([dir("dir")])]).stream(), {
    ...options(directory),
    signal: abort.signal,
  });
  try {
    expect(held()).toBe(before + 3);
    abort.abort(new Error("epoch replaced"));
    for (let wait = 0; wait < 20 && held() !== before; wait++) await Bun.sleep(0);
    expect(held()).toBe(before);
    await expect(handle.entryAt(0)).rejects.toThrow("epoch replaced");
  } finally {
    await handle.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("fresh sealed native custody refuses a same-inode raw rewrite before replay", async () => {
  const directory = await root();
  const raw = await bytes([dir("dir")]);
  const handle = await createVerifiedCheckpointArchive(new Blob([raw]).stream(), options(directory));
  const native = await import("node:fs");
  try {
    const descriptor = native
      .readdirSync("/dev/fd")
      .map(Number)
      .find((fd) => {
        try {
          const stat = native.fstatSync(fd);
          return stat.isFile() && stat.nlink === 0 && stat.size === raw.length;
        } catch {
          return false;
        }
      });
    expect(descriptor).toBeDefined();
    if (descriptor === undefined) throw new Error("Expected the exact held raw spool descriptor.");
    native.writeSync(descriptor, Buffer.from("X"), 0, 1, 0);
    expect(() => handle.replay()).toThrow("changed");
    await expect(handle.lookup(0, "dir")).rejects.toThrow("changed");
    await expect(handle.close()).rejects.toThrow("changed");
  } finally {
    await handle.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("independent archive and index physical reservations refuse before prepared return", async () => {
  const directory = await root();
  const raw = await bytes([dir("dir")]);
  try {
    for (const limits of [
      { maxArchiveBytes: raw.length - 1, maxIndexBytes: 1_000_000 },
      { maxArchiveBytes: raw.length, maxIndexBytes: 1 },
    ]) {
      const source = new Blob([raw]).stream();
      await expect(createVerifiedCheckpointArchive(source, { ...options(directory), ...limits })).rejects.toThrow(
        "reservation",
      );
      expect(source.locked).toBe(false);
      expect(await readdir(directory)).toEqual([]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("logical admission loss refuses reads but still closes owned native resources", async () => {
  const directory = await root();
  let admitted = true;
  const handle = await createVerifiedCheckpointArchive(new Blob([await bytes([dir("dir")])]).stream(), {
    ...options(directory),
    check() {
      if (!admitted) throw new Error("restore operation fenced");
    },
  });
  try {
    admitted = false;
    expect(() => handle.validate()).toThrow("restore operation fenced");
    await expect(handle.close()).resolves.toBeUndefined();
    expect(handle.close()).toBe(handle.close());
    await expect(handle.entryAt(0)).rejects.toThrow("closed");
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await handle.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
