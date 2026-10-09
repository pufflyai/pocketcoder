import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { DockerDriver, FilesystemStorageDriver } from "@pstdio/pocketcoder-drivers";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { buildServer } from "../app";
import { checkpointHttpFixture } from "./checkpoint-transfer-fixture.test";

async function recoveryFixture() {
  const f = await checkpointHttpFixture(Buffer.from("x"));
  const server = buildServer({
    store: f.store,
    driver: new DockerDriver({ inputDir: join(f.directory, "inputs") }),
    storageDriver: new FilesystemStorageDriver({
      workspaceRoot: join(f.directory, "..", "live"),
      checkpointRoot: f.directory,
    }),
    pepper: "source-recovery-fixture",
    limits: DEFAULT_LIMITS,
    workspaceServerUrl: "http://127.0.0.1",
    checkpointTransferOptions: {
      directory: f.directory,
      agentBaseUrl: "http://127.0.0.1",
      limits: {
        deadlineMs: 3000,
        maxArchiveBytes: 65536,
        maxIndexBytes: 65536,
        maxQueueBytes: 65536,
        maxLedgerBytes: 65536,
      },
      retentionLimits: {
        maxCheckpointFiles: 100,
        maxRetainedBytes: 1000000,
        maxRetainedBytesPerPrincipal: 1000000,
        maxCheckpointsPerPrincipal: 10,
      },
      readCapacity: () => {
        throw new Error("Recovery cannot reserve transfer storage");
      },
    },
  });
  const at = new Date();
  await f.store.updateWorkspace(
    f.workspace.id,
    {
      registrationDigest: randomBytes(32),
      registrationExpiresAt: new Date(at.getTime() + 30000),
      reconnectDigest: randomBytes(32),
    },
    at,
  );
  await f.store.updateWorkspaceStorage(
    f.checkpoint.storageId,
    { state: "retained", retainedUntil: new Date(at.getTime() + 60000), lastErrorCode: "checkpoint_failed" },
    at,
  );
  return {
    ...f,
    server,
    async close() {
      await server.scheduler.drain();
      await server.checkpointTransfers?.close();
      await f.dispose();
    },
  };
}

test("caller cancel finishes a preserving source and clears retained storage authority", async () => {
  const f = await recoveryFixture();
  try {
    await f.store.updateOperation(f.operationId, { state: "failed", completedAt: new Date() }, new Date());
    await f.server.service.cancel(f.principal, f.workspace.id);
    await f.server.scheduler.drain();
    expect(await f.store.getWorkspace(f.workspace.id)).toMatchObject({
      state: "canceled",
      registrationDigest: null,
      registrationExpiresAt: null,
      reconnectDigest: null,
    });
    expect(await f.store.getStorage(f.checkpoint.storageId)).toMatchObject({ state: "deleted", retainedUntil: null });
  } finally {
    await f.close();
  }
});

test("recovery expiry skips active capture then settles the failed source lifecycle", async () => {
  const f = await recoveryFixture();
  try {
    await f.server.scheduler.sweep();
    expect((await f.store.getWorkspace(f.workspace.id))?.state).toBe("preserving");
    await f.store.updateWorkspaceStorage(
      f.checkpoint.storageId,
      { retainedUntil: new Date(Date.now() - 1) },
      new Date(),
    );
    await f.server.scheduler.sweep();
    expect((await f.store.getWorkspace(f.workspace.id))?.state).toBe("preserving");
    await f.store.updateOperation(f.operationId, { state: "failed", completedAt: new Date() }, new Date());
    await f.server.scheduler.sweep();
    await f.server.scheduler.drain();
    expect(await f.store.getWorkspace(f.workspace.id)).toMatchObject({
      state: "expired",
      reasonCode: "checkpoint_failed",
      registrationDigest: null,
      reconnectDigest: null,
    });
    expect(await f.store.getStorage(f.checkpoint.storageId)).toMatchObject({ state: "deleted", retainedUntil: null });
  } finally {
    await f.close();
  }
});
