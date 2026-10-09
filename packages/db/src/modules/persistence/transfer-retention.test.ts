import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { checkpointTransferFixture } from "./transfer-fixture.test";

const limits = {
  maxCheckpointFiles: 10,
  maxRetainedBytes: 100,
  maxRetainedBytesPerPrincipal: 100,
  maxCheckpointsPerPrincipal: 10,
};
test.each([
  "maxCheckpointFiles",
  "maxRetainedBytes",
  "maxRetainedBytesPerPrincipal",
  "maxCheckpointsPerPrincipal",
] as const)("measured grant enforces %s before allocating physical storage", async (key) => {
  const f = await checkpointTransferFixture();
  try {
    const input = {
      ...f.input,
      header: { ...f.input.header, mounts: [{ name: "worktree", logical_bytes: 1, file_count: 1 }] },
      retentionLimits: { ...limits, [key]: 0 },
    };
    await expect(
      f.store.checkpointTransfers.grantUpload(
        input,
        () => f.capacity,
        () => {},
      ),
    ).rejects.toThrow("retention");
    expect(await f.store.checkpointTransfers.get(input.id)).toBeNull();
    expect(await f.store.storageReservations.get(input.reservationId)).toBeNull();
  } finally {
    await f.dispose();
  }
});

test("retained and in-flight measured declarations share one locked logical quota", async () => {
  const f = await checkpointTransferFixture();
  try {
    const retained = await f.store.insertCheckpoint({
      ...f.checkpoint,
      id: randomUUID(),
      state: "ready",
      logicalBytes: 2,
    });
    const input = {
      ...f.input,
      header: { ...f.input.header, mounts: [{ name: "worktree", logical_bytes: 2, file_count: 1 }] },
      retentionLimits: { ...limits, maxRetainedBytes: 5 },
    };
    await f.store.checkpointTransfers.grantUpload(
      input,
      () => f.capacity,
      () => {},
    );
    const second = await f.store.insertCheckpoint({ ...f.checkpoint, id: randomUUID() });
    const operation = await f.store.getOperation(f.input.operationId);
    if (!operation) throw new Error("preserve operation missing");
    const operationId = randomUUID();
    await f.store.insertOperation({
      ...operation,
      id: operationId,
      idempotencyKey: operationId,
      checkpointId: second.id,
    });
    const next = {
      ...input,
      id: randomUUID(),
      reservationId: randomUUID(),
      operationId,
      checkpointId: second.id,
      header: { ...input.header, checkpoint_id: second.id },
    };
    await expect(
      f.store.checkpointTransfers.grantUpload(
        next,
        () => f.capacity,
        () => {},
      ),
    ).rejects.toThrow("retention");
    expect(await f.store.checkpointTransfers.get(next.id)).toBeNull();
    expect((await f.store.getCheckpoint(retained.id))?.logicalBytes).toBe(2);
  } finally {
    await f.dispose();
  }
});
