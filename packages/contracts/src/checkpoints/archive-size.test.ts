import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import type { CheckpointArchiveEntry } from "./archive-format";
import { measureCheckpointArchive } from "./archive-size";
import { writeCheckpointArchive } from "./archive-writer";

test.each([0, 1, 511, 512, 513, 65_537])("measured archive matches real writer for %s payload bytes", async (size) => {
  const bytes = Buffer.alloc(size, 17);
  const header = {
    format: "pocketcoder-checkpoint-tar/v1" as const,
    checkpoint_id: randomUUID(),
    workspace_id: randomUUID(),
    template_digest: `sha256:${"a".repeat(64)}`,
    mounts: [{ name: "work", logical_bytes: size, file_count: 1 }],
  };
  const entry: CheckpointArchiveEntry = {
    mount: 0,
    path: "known",
    kind: "file",
    mode: 0o600,
    mtime_ns: "1000000000",
    size,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
  async function* entries() {
    yield entry;
  }
  async function* records() {
    yield { entry, payload: new Blob([bytes]).stream() };
  }
  const measured = await measureCheckpointArchive(header, entries());
  const actual = await new Response(
    writeCheckpointArchive(header, records(), { maxArchiveBytes: measured }),
  ).arrayBuffer();
  expect(actual.byteLength).toBe(measured);
});
