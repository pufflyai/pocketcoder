import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReadableStreamDefaultReader } from "node:stream/web";
import { fileURLToPath } from "node:url";
import {
  type CheckpointArchiveEntry,
  type CheckpointArchiveHeader,
  readCheckpointArchive,
} from "@pstdio/pocketcoder-contracts";
import { createFilesystemCheckpointUpload, prepareFilesystemCheckpointUpload } from "./filesystem-upload";

const digest = (bytes: Uint8Array | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc-filesystem-upload-")));
  const source = join(root, "source");
  const scratch = join(root, "scratch");
  const second = join(root, "second");
  await mkdir(source);
  await mkdir(second);
  writeFileSync(join(second, "a"), "secondary");
  await mkdir(scratch, { mode: 0o700 });
  await mkdir(join(source, "z"));
  await mkdir(join(source, "z", "empty"));
  const bytes = Buffer.alloc(130_049, 47);
  writeFileSync(join(source, "a"), bytes);
  writeFileSync(join(source, "z", "ä"), "nested");
  await symlink("../a", join(source, "z", "link"));
  await symlink("missing", join(source, "deadlink"));
  const logicalBytes = bytes.length + 6 + 4 + 7;
  const identity: Omit<CheckpointArchiveHeader, "mounts"> = {
    format: "pocketcoder-checkpoint-tar/v1",
    checkpoint_id: randomUUID(),
    workspace_id: randomUUID(),
    template_digest: digest("template"),
  };
  const sources = [
    { root: source, policy: { name: "worktree", target: "/workspace", maxFiles: 6, maxBytes: logicalBytes } },
    { root: second, policy: { name: "state", target: "/state", maxFiles: 1, maxBytes: 9 } },
  ];
  const options = {
    directory: scratch,
    maxIndexBytes: 1_000_000,
    maxQueueBytes: 1_000_000,
    maxArchiveBytes: 1_000_000,
    check() {},
  };
  return {
    root,
    source,
    scratch,
    bytes,
    logicalBytes,
    identity,
    sources,
    options,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

async function waitForDescriptors(baseline: number) {
  for (let attempt = 0; attempt < 50 && readdirSync("/dev/fd").length !== baseline; attempt++) await Bun.sleep(1);
  expect(readdirSync("/dev/fd").length).toBe(baseline);
}

test("real filesystem HTTP upload uses captured totals, sorted graph and native content", async () => {
  const f = await fixture();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (!request.body) throw new Error("Expected upload body");
      const entries: CheckpointArchiveEntry[] = [];
      const hashes = new Map<string, ReturnType<typeof createHash>>();
      const receipt = await readCheckpointArchive(request.body, {
        maxArchiveBytes: 1_000_000,
        async onEntry(entry) {
          entries.push(entry);
          if (entry.kind === "file") hashes.set(`${entry.mount}:${entry.path}`, createHash("sha256"));
        },
        async onData(entry, bytes) {
          hashes.get(`${entry.mount}:${entry.path}`)?.update(bytes);
        },
      });
      return Response.json({
        header: receipt.header,
        entries,
        digests: Object.fromEntries([...hashes].map(([path, hash]) => [path, `sha256:${hash.digest("hex")}`])),
      });
    },
  });
  try {
    const source = await createFilesystemCheckpointUpload(f.identity, f.sources, f.options);
    const response = await fetch(server.url, { method: "PUT", body: source });
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      header: CheckpointArchiveHeader;
      entries: CheckpointArchiveEntry[];
      digests: Record<string, string>;
    };
    expect(result.header).toEqual({
      ...f.identity,
      mounts: [
        { name: "worktree", logical_bytes: f.logicalBytes, file_count: 6 },
        { name: "state", logical_bytes: 9, file_count: 1 },
      ],
    });
    expect(result.entries.map((entry: CheckpointArchiveEntry) => `${entry.mount}:${entry.path}`)).toEqual([
      "0:a",
      "0:deadlink",
      "0:z",
      "0:z/empty",
      "0:z/link",
      "0:z/ä",
      "1:a",
    ]);
    expect(result.digests).toEqual({ "0:a": digest(f.bytes), "0:z/ä": digest("nested"), "1:a": digest("secondary") });
    expect(result.entries.find((entry: CheckpointArchiveEntry) => entry.path === "z/link")).toHaveProperty(
      "link_target",
      "../a",
    );
    expect(await readFile(join(f.source, "a"))).toEqual(f.bytes);
    expect(readdirSync(f.scratch)).toEqual([]);
    expect(readdirSync(f.source).sort()).toEqual(["a", "deadlink", "z"]);
  } finally {
    await server.stop(true);
    await f.close();
  }
});

test("filesystem upload abort before any consumer closes capture and anonymous scratch FDs", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const baseline = readdirSync("/dev/fd").length;
  try {
    const source = await createFilesystemCheckpointUpload(f.identity, f.sources, {
      ...f.options,
      signal: abort.signal,
    });
    expect(readdirSync("/dev/fd").length).toBeGreaterThan(baseline);
    abort.abort(new Error("workspace purged before upload"));
    const reader = source.getReader();
    try {
      await expect(reader.read()).rejects.toThrow("workspace purged before upload");
    } finally {
      reader.releaseLock();
    }
    await waitForDescriptors(baseline);
    expect(readdirSync(f.scratch)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("same-inode edit after preparation refuses upload and drains capture", async () => {
  const f = await fixture();
  const baseline = readdirSync("/dev/fd").length;
  try {
    const source = await createFilesystemCheckpointUpload(f.identity, f.sources, f.options);
    const before = lstatSync(join(f.source, "a"), { bigint: true });
    await Bun.sleep(1);
    writeFileSync(join(f.source, "a"), Buffer.alloc(f.bytes.length, 42));
    const after = lstatSync(join(f.source, "a"), { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(before.size);
    await expect(readCheckpointArchive(source, { maxArchiveBytes: 1_000_000 })).rejects.toThrow("changed");
    await waitForDescriptors(baseline);
  } finally {
    await f.close();
  }
});

test("nonfile namespace change after preparation is refused before archive success", async () => {
  const f = await fixture();
  const baseline = readdirSync("/dev/fd").length;
  try {
    const source = await createFilesystemCheckpointUpload(f.identity, f.sources, f.options);
    await mkdir(join(f.source, "z", "late"));
    await expect(readCheckpointArchive(source, { maxArchiveBytes: 1_000_000 })).rejects.toThrow("changed");
    await waitForDescriptors(baseline);
  } finally {
    await f.close();
  }
});

test("consumer cancellation during actual payload transfer drains native and scratch files", async () => {
  const f = await fixture();
  const baseline = readdirSync("/dev/fd").length;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const source = await createFilesystemCheckpointUpload(f.identity, f.sources, f.options);
    const owned = source.getReader();
    reader = owned;
    while (true) {
      const next = await owned.read();
      if (next.done) throw new Error("Expected native file payload");
      if (next.value.length === 65_536 && next.value.every((byte) => byte === 47)) break;
    }
    expect(readdirSync("/dev/fd").length).toBeGreaterThan(baseline);
    const pending = owned.read();
    await Promise.resolve();
    await owned.cancel("HTTP destination disconnected");
    await pending;
    owned.releaseLock();
    reader = undefined;
    await waitForDescriptors(baseline);
    expect(readdirSync(f.scratch)).toEqual([]);
  } finally {
    await reader?.cancel();
    reader?.releaseLock();
    await f.close();
  }
});

test("scratch inside a captured mount is refused without leaked capture handles", async () => {
  const f = await fixture();
  const baseline = readdirSync("/dev/fd").length;
  try {
    await expect(
      createFilesystemCheckpointUpload(f.identity, f.sources, { ...f.options, directory: join(f.source, "z") }),
    ).rejects.toThrow("outside captured mounts");
    expect(readdirSync("/dev/fd").length).toBe(baseline);
    expect(readdirSync(f.source).sort()).toEqual(["a", "deadlink", "z"]);
  } finally {
    await f.close();
  }
});

test("filesystem checkpoint bundle excludes the database engine and ORM", async () => {
  const build = await Bun.build({
    entrypoints: [fileURLToPath(import.meta.resolve("./filesystem-upload"))],
    target: "bun",
  });
  expect(build.success).toBe(true);
  expect(await build.outputs[0]?.text()).not.toMatch(/PGlite|electric-sql|drizzle-orm|pglite\.wasm/);
});

test("already aborted preparation releases real capture roots without creating an upload", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const baseline = readdirSync("/dev/fd").length;
  abort.abort(new Error("workspace expired before capture"));
  try {
    await expect(
      createFilesystemCheckpointUpload(f.identity, f.sources, { ...f.options, signal: abort.signal }),
    ).rejects.toThrow("workspace expired before capture");
    expect(readdirSync("/dev/fd").length).toBe(baseline);
    expect(readdirSync(f.scratch)).toEqual([]);
  } finally {
    await f.close();
  }
});

test.each([1, -1])(
  "archive reservation %s refusal releases native capture and scratch custody",
  async (maxArchiveBytes) => {
    const f = await fixture();
    const baseline = readdirSync("/dev/fd").length;
    try {
      const preparing = createFilesystemCheckpointUpload(f.identity, f.sources, { ...f.options, maxArchiveBytes });
      if (maxArchiveBytes < 0) await expect(preparing).rejects.toThrow("reservation");
      else await expect(new Response(await preparing).arrayBuffer()).rejects.toThrow("physical reservation");
      await waitForDescriptors(baseline);
      expect(readdirSync(f.scratch)).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

test("prepared capture declares exact bytes before granting a one-use upload", async () => {
  const f = await fixture();
  try {
    const prepared = await prepareFilesystemCheckpointUpload(f.identity, f.sources, f.options);
    expect(prepared.header.mounts[0]?.logical_bytes).toBe(f.logicalBytes);
    expect(prepared.archiveBytes).toBeGreaterThan(f.logicalBytes);
    const bytes = await new Response(prepared.upload()).arrayBuffer();
    expect(bytes.byteLength).toBe(prepared.archiveBytes);
    expect(() => prepared.upload()).toThrow("already consumed");
    await prepared.close();
    expect(readdirSync(f.scratch)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("ungranted prepared capture closes native custody without opening payload", async () => {
  const f = await fixture();
  const baseline = readdirSync("/dev/fd").length;
  try {
    const prepared = await prepareFilesystemCheckpointUpload(f.identity, f.sources, f.options);
    await prepared.close();
    expect(() => prepared.upload()).toThrow("closed");
    await waitForDescriptors(baseline);
  } finally {
    await f.close();
  }
});
