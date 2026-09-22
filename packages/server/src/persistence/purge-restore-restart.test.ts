import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { reconcilePersistence, type StorageRef } from "@pstdio/pocketcoder-runtime-core";
import { failedAllocation } from "./purge-support.test";

async function interruptedRestore(createTarget: boolean) {
  const app = await failedAllocation();
  const source = await app.store.getWorkspace(app.workspace.id);
  if (!source) throw new Error("Missing source");
  const checkpointId = crypto.randomUUID();
  const snapshot = await app.storageDriver.snapshot(
    app.storage.providerRef as StorageRef,
    checkpointId,
    app.parsed.digest,
    app.storage.mountManifest,
  );
  const at = new Date();
  await app.store.insertCheckpoint({
    id: checkpointId,
    workspaceId: source.id,
    principalId: source.principalId,
    storageId: app.storage.id,
    parentCheckpointId: null,
    state: "ready",
    reasonCode: null,
    providerKind: app.storageDriver.kind,
    providerRef: snapshot.ref,
    templateSnapshot: source.templateSnapshot,
    templateDigest: source.templateDigest,
    sourceProvenance: null,
    manifest: snapshot.manifest,
    manifestDigest: snapshot.manifestDigest,
    logicalBytes: snapshot.manifest.logical_bytes,
    storedBytes: snapshot.storedBytes,
    fileCount: snapshot.manifest.file_count,
    conversationRestore: "filesystem_only",
    label: null,
    createdAt: at,
    updatedAt: at,
    readyAt: at,
    expiresAt: null,
    deletedAt: null,
  });
  const operationId = crypto.randomUUID();
  await app.store.insertOperation({
    id: operationId,
    principalId: source.principalId,
    kind: "restore",
    state: "pending",
    idempotencyKey: "interrupted-restore",
    requestDigest: "interrupted-restore",
    workspaceId: source.id,
    checkpointId,
    resultWorkspaceId: null,
    reasonCode: null,
    attemptCount: 0,
    createdAt: at,
    updatedAt: at,
    completedAt: null,
  });
  const targetId = crypto.randomUUID();
  if (createTarget) {
    await app.store.insertWorkspace({
      ...source,
      id: targetId,
      externalId: "interrupted-target",
      idempotencyKey: `restore:${operationId}`,
      requestDigest: "interrupted-restore",
      originWorkspaceId: source.id,
      restoredFromCheckpointId: checkpointId,
      launchMode: "restore",
    });
  }
  // These are the two committed states before restore admission saves its
  // resultWorkspaceId. Restart must distinguish the source from the target.
  await reconcilePersistence({ store: app.store, driver: app.driver, storageDriver: app.storageDriver });
  return { ...app, operationId, targetId };
}

test("restart fails a restore interrupted before target insertion so purge can finish", async () => {
  const app = await interruptedRestore(false);
  const purge = (await (await app.purge()).json()) as { id: string };
  await app.persistence.retryPurges();
  expect(await app.store.getOperation(purge.id)).toMatchObject({ state: "succeeded" });
  expect(await app.store.getOperation(app.operationId)).toMatchObject({
    state: "failed",
    reasonCode: "restore_failed",
  });
});

test("restart relinks a restore target committed before its operation link and drains its copy", async () => {
  const app = await interruptedRestore(true);
  expect(await app.store.getOperation(app.operationId)).toMatchObject({ resultWorkspaceId: app.targetId });
  const purge = (await (await app.purge()).json()) as { id: string };
  await app.persistence.retryPurges();
  expect(await app.store.getOperation(purge.id)).toMatchObject({
    state: "pending",
    reasonCode: "purge_operation_in_progress",
  });
  await app.scheduler.tick();
  await app.persistence.retryPurges();
  expect(await app.store.getOperation(purge.id)).toMatchObject({ state: "succeeded" });
  const storage = await app.store.getWorkspaceStorage(app.targetId);
  expect(await readFile(join(String(storage?.providerRef.root), "worktree", "marker.txt"), "utf8")).toBe(
    "synthetic retained content",
  );
});

for (const restart of [false, true]) {
  test(`a canceled restore cannot block source purge (restart=${restart})`, async () => {
    const app = await interruptedRestore(true);
    await app.service.cancel(app.principal, app.targetId);
    if (restart) await reconcilePersistence({ store: app.store, driver: app.driver, storageDriver: app.storageDriver });
    const purge = (await (await app.purge()).json()) as { id: string };
    await app.persistence.retryPurges();
    expect(await app.store.getOperation(purge.id)).toMatchObject({ state: "succeeded" });
    expect(await app.store.getOperation(app.operationId)).toMatchObject({
      state: "failed",
      reasonCode: "restore_failed",
    });
  });
}
