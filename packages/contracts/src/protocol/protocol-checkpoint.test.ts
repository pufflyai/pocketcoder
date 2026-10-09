import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  CheckpointPreparedPayload,
  PrepareCheckpointArchivePayload,
  RestoreTransferSpecSchema,
} from "./protocol-checkpoint";

const operation_id = randomUUID();
const checkpoint_id = randomUUID();
const header = {
  format: "pocketcoder-checkpoint-tar/v1",
  checkpoint_id,
  workspace_id: randomUUID(),
  template_digest: `sha256:${"a".repeat(64)}`,
  mounts: [],
};

test("prepared declaration binds the measured source header to its operation", () => {
  expect(
    CheckpointPreparedPayload.parse({ operation_id, checkpoint_id, header, archive_bytes: 4096 }).archive_bytes,
  ).toBe(4096);
  expect(
    CheckpointPreparedPayload.safeParse({ operation_id, checkpoint_id: randomUUID(), header, archive_bytes: 4096 })
      .success,
  ).toBe(false);
  expect(
    CheckpointPreparedPayload.safeParse({ operation_id, checkpoint_id, header, archive_bytes: Infinity }).success,
  ).toBe(false);
});

test("transfer limits and grant lifetimes are finite", () => {
  expect(
    PrepareCheckpointArchivePayload.safeParse({
      operation_id,
      checkpoint_id,
      deadline_ms: Infinity,
      mounts: [],
      max_archive_bytes: 4096,
      max_index_bytes: 4096,
      max_queue_bytes: 4096,
    }).success,
  ).toBe(false);
  expect(
    RestoreTransferSpecSchema.safeParse({
      operation_id,
      transfer_id: randomUUID(),
      credential: "grant",
      url: "http://127.0.0.1/checkpoint",
      expires_at: "never",
    }).success,
  ).toBe(false);
});
