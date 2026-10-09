import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECKPOINT_PAYLOAD_BYTES, type CheckpointArchiveEntry, type CheckpointArchiveHeader } from "./archive-format";
import { readCheckpointArchive } from "./archive-reader";
import { writeCheckpointArchive } from "./archive-writer";

const digest = (bytes: Uint8Array | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function header(logicalBytes: number, fileCount: number): CheckpointArchiveHeader {
  return {
    format: "pocketcoder-checkpoint-tar/v1",
    checkpoint_id: randomUUID(),
    workspace_id: randomUUID(),
    template_digest: digest("template"),
    mounts: [{ name: "worktree", logical_bytes: logicalBytes, file_count: fileCount }],
  };
}
function file(path: string, bytes: Uint8Array): CheckpointArchiveEntry {
  return { mount: 0, path, kind: "file", size: bytes.length, digest: digest(bytes), mode: 0o751, mtime_ns: "42" };
}

test("streams real disk content in bounded pieces and preserves modes, directories and safe links", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc-checkpoint-codec-"));
  const body = Buffer.alloc(130_049, 83);
  const path = join(directory, "payload");
  await writeFile(path, body);
  const h = header(body.length + 7, 3);
  const entries: CheckpointArchiveEntry[] = [
    { mount: 0, path: "dir", kind: "directory", size: 0, mode: 0o750, mtime_ns: "41" },
    file("dir/content", body),
    {
      mount: 0,
      path: "link",
      kind: "symlink",
      size: 7,
      mode: 0o777,
      mtime_ns: "43",
      link_target: "dir/sub",
      digest: digest("dir/sub"),
    },
  ];
  async function* records() {
    for (const entry of entries) yield { entry, payload: entry.kind === "file" ? Bun.file(path).stream() : undefined };
  }
  const content = createHash("sha256");
  const received: CheckpointArchiveEntry[] = [];
  let largest = 0;
  try {
    const result = await readCheckpointArchive(writeCheckpointArchive(h, records(), { maxArchiveBytes: 200_000 }), {
      maxArchiveBytes: 200_000,
      onEntry: async (entry) => {
        received.push(entry);
      },
      onData: async (_entry, bytes) => {
        largest = Math.max(largest, bytes.length);
        content.update(bytes);
      },
    });
    expect(received).toEqual(entries);
    expect(result.header).toEqual(h);
    expect(`sha256:${content.digest("hex")}`).toBe(digest(body));
    expect(largest).toBe(65_536);
    expect(result.archiveBytes).toBeGreaterThan(body.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["duplicate", "out-of-order", "too-short", "too-long", "digest"])(
  "rejects invalid producer %s",
  async (change) => {
    const bytes = Buffer.from("payload");
    const entry = file("content", bytes);
    async function* records() {
      let data = bytes;
      if (change === "too-short") data = bytes.subarray(1);
      if (change === "too-long") data = Buffer.concat([bytes, bytes]);
      yield {
        entry: change === "digest" ? { ...entry, digest: digest("wrong") } : entry,
        payload: new Blob([data]).stream(),
      };
      if (change === "duplicate" || change === "out-of-order")
        yield {
          entry: { ...entry, path: change === "duplicate" ? "content" : "before" },
          payload: new Blob([bytes]).stream(),
        };
    }
    await expect(
      new Response(
        writeCheckpointArchive(header(bytes.length * 2, 2), records(), { maxArchiveBytes: 20_000 }),
      ).arrayBuffer(),
    ).rejects.toThrow();
  },
);

test("cancels an outstanding real stream read and drains its input", async () => {
  const abort = new AbortController();
  let pulled!: () => void;
  const waiting = new Promise<void>((resolve) => {
    pulled = resolve;
  });
  let canceled = false;
  const source = new ReadableStream<Uint8Array>({
    pull() {
      pulled();
    },
    cancel() {
      canceled = true;
    },
  });
  const pending = readCheckpointArchive(source, { maxArchiveBytes: 1024, signal: abort.signal });
  await waiting;
  abort.abort(new Error("transfer canceled"));
  await expect(pending).rejects.toThrow("transfer canceled");
  expect(canceled).toBe(true);
  expect(source.locked).toBe(false);
});

test("consumer cancellation drains a blocked producer payload without a caller signal", async () => {
  let pulled!: () => void;
  const waiting = new Promise<void>((resolve) => {
    pulled = resolve;
  });
  let canceled = false;
  let closed = false;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const payload = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
      },
      pull() {
        pulled();
      },
      cancel() {
        canceled = true;
      },
    },
    { highWaterMark: 0 },
  );
  async function* records() {
    try {
      yield { entry: file("content", Buffer.from("body")), payload };
    } finally {
      closed = true;
    }
  }
  const source = writeCheckpointArchive(header(4, 1), records(), { maxArchiveBytes: 20_000 });
  const reader = source.getReader();
  const reading = (async () => {
    while (!(await reader.read()).done) {}
  })();
  let cancel: Promise<void> | undefined;
  try {
    await waiting;
    cancel = reader.cancel("destination disconnected");
    const result = await Promise.race([cancel.then(() => "drained"), Bun.sleep(100).then(() => "blocked")]);
    expect(result).toBe("drained");
    expect(canceled).toBe(true);
    expect(closed).toBe(true);
    expect(payload.locked).toBe(false);
  } finally {
    if (!canceled) controller.close();
    await cancel;
    await reading;
  }
});

test("streams a real file larger than one tar payload member without large output chunks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc-checkpoint-large-"));
  const path = join(directory, "payload");
  const size = CHECKPOINT_PAYLOAD_BYTES + 513;
  const handle = await open(path, "wx", 0o600);
  await handle.truncate(size);
  await handle.close();
  const hash = createHash("sha256");
  const zeros = Buffer.alloc(65_536);
  for (let offset = 0; offset < size; offset += zeros.length)
    hash.update(zeros.subarray(0, Math.min(zeros.length, size - offset)));
  const entry: CheckpointArchiveEntry = {
    mount: 0,
    path: "content",
    kind: "file",
    size,
    digest: `sha256:${hash.digest("hex")}`,
    mode: 0o600,
    mtime_ns: "0",
  };
  async function* records() {
    yield { entry, payload: Bun.file(path).stream() };
  }
  let received = 0;
  let largest = 0;
  try {
    await readCheckpointArchive(writeCheckpointArchive(header(size, 1), records(), { maxArchiveBytes: size + 8192 }), {
      maxArchiveBytes: size + 8192,
      onData: async (_entry, bytes) => {
        received += bytes.length;
        largest = Math.max(largest, bytes.length);
      },
    });
    expect(received).toBe(size);
    expect(largest).toBe(65_536);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("streams many small records without an aggregate manifest document", async () => {
  const files = 3000;
  async function* records() {
    for (let index = 0; index < files; index++)
      yield {
        entry: {
          mount: 0,
          path: `entry-${String(index).padStart(8, "0")}`,
          kind: "directory" as const,
          size: 0 as const,
          mode: 0o700,
          mtime_ns: "0",
        },
      };
  }
  let received = 0;
  const result = await readCheckpointArchive(
    writeCheckpointArchive(header(0, files), records(), { maxArchiveBytes: 4_000_000 }),
    {
      maxArchiveBytes: 4_000_000,
      onEntry: async () => {
        received++;
      },
    },
  );
  expect(received).toBe(files);
  expect(result.summary.mounts).toEqual([{ name: "worktree", logical_bytes: 0, file_count: files }]);
});
