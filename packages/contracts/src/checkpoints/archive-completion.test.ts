import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import type { CheckpointArchiveEntry } from "./archive-format";
import { readCheckpointArchive } from "./archive-reader";
import { writeCheckpointArchive } from "./archive-writer";

const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const entries: CheckpointArchiveEntry[] = [
  { mount: 0, path: "a", kind: "directory", size: 0, mode: 448, mtime_ns: "0" },
  { mount: 0, path: "empty", kind: "file", size: 0, mode: 384, mtime_ns: "0", digest: digest("") },
  { mount: 0, path: "last", kind: "file", size: 7, mode: 384, mtime_ns: "0", digest: digest("payload") },
];
async function archive() {
  async function* records() {
    for (const entry of entries)
      yield { entry, payload: entry.kind === "file" ? new Blob([entry.size ? "payload" : ""]).stream() : undefined };
  }
  return Buffer.from(
    await new Response(
      writeCheckpointArchive(
        {
          format: "pocketcoder-checkpoint-tar/v1",
          checkpoint_id: randomUUID(),
          workspace_id: randomUUID(),
          template_digest: digest("template"),
          mounts: [{ name: "worktree", logical_bytes: 7, file_count: 3 }],
        },
        records(),
        { maxArchiveBytes: 20_000 },
      ),
    ).arrayBuffer(),
  );
}

test("entry completion is awaited after directory, empty and final file verification", async () => {
  const bytes = await archive();
  const events: string[] = [];
  await readCheckpointArchive(new Blob([bytes]).stream(), {
    maxArchiveBytes: 20_000,
    async onEntry(entry) {
      events.push(`start:${entry.path}`);
    },
    async onData(entry) {
      events.push(`data:${entry.path}`);
    },
    async onEntryComplete(entry) {
      await Bun.sleep(0);
      events.push(`complete:${entry.path}`);
    },
  });
  expect(events).toEqual([
    "start:a",
    "complete:a",
    "start:empty",
    "complete:empty",
    "start:last",
    "data:last",
    "complete:last",
  ]);
});

test("digest refusal never calls completion and completion failure cancels the actual reader", async () => {
  const bytes = await archive();
  bytes[bytes.lastIndexOf(Buffer.from("payload"))] = 88;
  const complete: string[] = [];
  await expect(
    readCheckpointArchive(new Blob([bytes]).stream(), {
      maxArchiveBytes: 20_000,
      async onEntryComplete(entry) {
        complete.push(entry.path);
      },
    }),
  ).rejects.toThrow("digest");
  expect(complete).toEqual(["a", "empty"]);
  const source = new Blob([await archive()]).stream();
  await expect(
    readCheckpointArchive(source, {
      maxArchiveBytes: 20_000,
      async onEntryComplete() {
        throw new Error("entry sync refused");
      },
    }),
  ).rejects.toThrow("entry sync refused");
  expect(source.locked).toBe(false);
});

test("completion rejection retains its cause when actual source cancellation also rejects", async () => {
  const bytes = await archive();
  let canceled = false;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
    },
    cancel() {
      canceled = true;
      throw new Error("cancel cleanup refused");
    },
  });
  await expect(
    readCheckpointArchive(source, {
      maxArchiveBytes: 20_000,
      async onEntryComplete() {
        throw new Error("entry completion refused");
      },
    }),
  ).rejects.toThrow("entry completion refused");
  expect(canceled).toBe(true);
  expect(source.locked).toBe(false);
});
