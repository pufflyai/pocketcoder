import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReadableStreamDefaultReader } from "node:stream/web";
import { fileURLToPath } from "node:url";
import {
  type CheckpointArchiveEntry,
  type CheckpointArchiveHeader,
  readCheckpointArchive,
} from "@pstdio/pocketcoder-contracts";
import { trackCheckpointFiles } from "@pstdio/pocketcoder-testkit";
import { createCheckpointUpload } from "./checkpoint-upload";

const digest = (bytes: Uint8Array | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc-supervisor-upload-")));
  const stage = join(root, "stage");
  await mkdir(stage, { mode: 0o700 });
  const payload = Buffer.alloc(130_049, 47);
  await writeFile(join(root, "content"), payload);
  const records: CheckpointArchiveEntry[] = [
    {
      mount: 0,
      path: "dir/content",
      kind: "file",
      mode: 0o600,
      mtime_ns: "0",
      size: payload.length,
      digest: digest(payload),
    },
    { mount: 0, path: "dir", kind: "directory", mode: 0o700, mtime_ns: "0", size: 0 },
  ];
  const header: CheckpointArchiveHeader = {
    format: "pocketcoder-checkpoint-tar/v1",
    checkpoint_id: randomUUID(),
    workspace_id: randomUUID(),
    template_digest: digest("template"),
    mounts: [{ name: "worktree", logical_bytes: payload.length, file_count: records.length }],
  };
  async function* entries() {
    for (const record of records) yield record;
  }
  const owned = trackCheckpointFiles(stage);
  const unrelated = openSync(join(root, "content"), "r");
  const survivor = openSync(join(root, "content"), "r");
  let unrelatedClosed = false;
  function closeUnrelated() {
    if (!unrelatedClosed) closeSync(unrelated);
    unrelatedClosed = true;
  }
  return {
    root,
    stage,
    payload,
    header,
    entries,
    owned,
    closeUnrelated,
    async close() {
      closeUnrelated();
      try {
        const bytes = Buffer.alloc(payload.length);
        expect(readSync(survivor, bytes, 0, bytes.length, 0)).toBe(bytes.length);
        expect(bytes).toEqual(payload);
      } finally {
        closeSync(survivor);
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("a real HTTP upload sorts disk metadata and streams actual file bytes", async () => {
  const f = await fixture();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (!request.body) throw new Error("Expected a real upload body");
      const paths: string[] = [];
      const hash = createHash("sha256");
      const receipt = await readCheckpointArchive(request.body, {
        maxArchiveBytes: 1_000_000,
        async onEntry(entry) {
          paths.push(entry.path);
        },
        async onData(_entry, bytes) {
          hash.update(bytes);
        },
      });
      return Response.json({ paths, header: receipt.header, digest: `sha256:${hash.digest("hex")}` });
    },
  });
  try {
    const source = await createCheckpointUpload(f.header, f.entries(), {
      directory: f.stage,
      maxIndexBytes: 1_000_000,
      maxArchiveBytes: 1_000_000,
      check() {
        f.owned.snapshot();
      },
      async openPayload() {
        return Bun.file(join(f.root, "content")).stream();
      },
    });
    const response = await fetch(server.url, { method: "PUT", body: source });
    expect(await response.json()).toEqual({
      paths: ["dir", "dir/content"],
      header: f.header,
      digest: digest(f.payload),
    });
    expect(await readFile(join(f.root, "content"))).toEqual(f.payload);
    expect(readdirSync(f.stage)).toEqual([]);
  } finally {
    await server.stop(true);
    await f.close();
  }
});

test("consumer cancellation before its first read releases the prepared sort index", async () => {
  const f = await fixture();
  let opened = false;
  try {
    const source = await createCheckpointUpload(f.header, f.entries(), {
      directory: f.stage,
      maxIndexBytes: 1_000_000,
      maxArchiveBytes: 1_000_000,
      check() {
        f.owned.snapshot();
      },
      async openPayload() {
        opened = true;
        return Bun.file(join(f.root, "content")).stream();
      },
    });
    expect(f.owned.snapshot()).toHaveLength(4);
    const released = new Set(f.owned.snapshot().map(({ fd }) => fd));
    f.closeUnrelated();
    await source.cancel("destination disconnected");
    expect(opened).toBe(false);
    expect(f.owned.snapshot()).toHaveLength(0);
    const replacements: number[] = [];
    try {
      // Fill lower unrelated holes too, so the second cancellation sees a reused owned FD.
      for (let count = 0; count <= Math.max(...released); count++) {
        const replacement = openSync(join(f.root, "content"), "r");
        replacements.push(replacement);
        if (released.has(replacement)) break;
      }
      expect(replacements.some((fd) => released.has(fd))).toBe(true);
      await source.cancel("repeated cancellation");
      for (const replacement of replacements) {
        expect(fstatSync(replacement).size).toBe(f.payload.length);
        const bytes = Buffer.alloc(f.payload.length);
        expect(readSync(replacement, bytes, 0, bytes.length, 0)).toBe(bytes.length);
        expect(bytes).toEqual(f.payload);
      }
      expect(f.owned.snapshot()).toHaveLength(0);
    } finally {
      for (const replacement of replacements) closeSync(replacement);
    }
  } finally {
    await f.close();
  }
});

test("prepared upload abort releases its disk index without a consumer read", async () => {
  const f = await fixture();
  const abort = new AbortController();
  try {
    const source = await createCheckpointUpload(f.header, f.entries(), {
      directory: f.stage,
      maxIndexBytes: 1_000_000,
      maxArchiveBytes: 1_000_000,
      signal: abort.signal,
      check() {
        f.owned.snapshot();
      },
      async openPayload() {
        return Bun.file(join(f.root, "content")).stream();
      },
    });
    expect(f.owned.snapshot()).toHaveLength(4);
    abort.abort(new Error("workspace purged"));
    const reader = source.getReader();
    try {
      await expect(reader.read()).rejects.toThrow("workspace purged");
    } finally {
      reader.releaseLock();
    }
    for (let attempt = 0; attempt < 20 && f.owned.snapshot().length !== 0; attempt++) await Bun.sleep(1);
    expect(f.owned.snapshot()).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("cancelling an active upload drains a blocked payload and its disk index", async () => {
  const f = await fixture();
  const started = Promise.withResolvers<void>();
  let canceled = false;
  let payloadController!: ReadableStreamDefaultController<Uint8Array>;
  const payload = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        payloadController = controller;
      },
      pull() {
        started.resolve();
      },
      cancel() {
        canceled = true;
      },
    },
    { highWaterMark: 0 },
  );
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let consuming: Promise<void> | undefined;
  let cancel: Promise<void> | undefined;
  try {
    const source = await createCheckpointUpload(f.header, f.entries(), {
      directory: f.stage,
      maxIndexBytes: 1_000_000,
      maxArchiveBytes: 1_000_000,
      check() {
        f.owned.snapshot();
      },
      async openPayload() {
        return payload;
      },
    });
    expect(f.owned.snapshot()).toHaveLength(4);
    const owned = source.getReader();
    reader = owned;
    consuming = (async () => {
      while (!(await owned.read()).done) {}
    })();
    await started.promise;
    f.closeUnrelated();
    cancel = owned.cancel("destination disconnected");
    expect(await Promise.race([cancel.then(() => true), Bun.sleep(100).then(() => false)])).toBe(true);
    expect(canceled).toBe(true);
    expect(payload.locked).toBe(false);
    expect(f.owned.snapshot()).toHaveLength(0);
  } finally {
    if (!canceled) payloadController.close();
    await cancel;
    await consuming;
    reader?.releaseLock();
    await f.close();
  }
});

test("invalid complete graph refuses before opening payloads and releases its index", async () => {
  const f = await fixture();
  async function* entries() {
    yield {
      mount: 0,
      path: "missing/content",
      kind: "file" as const,
      mode: 0o600,
      mtime_ns: "0",
      size: f.payload.length,
      digest: digest(f.payload),
    };
  }
  try {
    await expect(
      createCheckpointUpload(f.header, entries(), {
        directory: f.stage,
        maxIndexBytes: 1_000_000,
        maxArchiveBytes: 1_000_000,
        check() {
          f.owned.snapshot();
        },
        async openPayload() {
          throw new Error("Invalid graph must not open payloads");
        },
      }),
    ).rejects.toThrow("parent");
    expect(f.owned.snapshot()).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("the supervisor checkpoint bundle has no database engine or ORM", async () => {
  const build = await Bun.build({
    entrypoints: [fileURLToPath(import.meta.resolve("./checkpoint-upload"))],
    target: "bun",
  });
  expect(build.success).toBe(true);
  const source = await build.outputs[0]?.text();
  expect(source).toBeDefined();
  expect(source).not.toMatch(/PGlite|electric-sql|drizzle-orm|pglite\.wasm/);
});
