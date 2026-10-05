import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import type { StorageRef } from "@pstdio/pocketcoder-runtime-core";
import { server, waitFor } from "./persistence-support.test";

const createStore = createTestStoreFactory();

async function preservedSource(failPreserve = false) {
  const app = await server(await createStore());
  const response = await app.request("/v1/workspaces", {
    method: "POST",
    headers: { "idempotency-key": "cleanup-source" },
    body: JSON.stringify({ external_id: "cleanup-source", template: { name: "fixture-persistent" } }),
  });
  expect(response.status).toBe(201);
  const workspace = (await response.json()) as { id: string };
  await app.scheduler.tick();
  await waitFor(async () => (await app.store.getWorkspaceStorage(workspace.id))?.state === "ready");
  const now = new Date();
  await app.store.transition(workspace.id, { from: ["provisioning"], to: "connected", at: now });
  await app.store.transition(workspace.id, { from: ["connected"], to: "ready", at: now });
  const storage = await app.store.getWorkspaceStorage(workspace.id);
  if (!storage) throw new Error("missing source allocation");
  const marker = join(String(storage.providerRef.root), "worktree", "marker.txt");
  await writeFile(marker, "recoverable source");
  if (failPreserve) {
    await app.store.updateWorkspaceStorage(
      storage.id,
      {
        providerRef: { ...storage.providerRef, root: "/invalid-allocation" },
      },
      now,
    );
  }
  const preserve = await app.request(`/v1/workspaces/${workspace.id}/preserve`, {
    method: "POST",
    headers: { "idempotency-key": "cleanup-preserve" },
    body: "{}",
  });
  expect(preserve.status).toBe(202);
  const result = (await preserve.json()) as { checkpoint: { id: string }; operation: { id: string } };
  await waitFor(
    async () => (await app.store.getOperation(result.operation.id))?.state === (failPreserve ? "failed" : "succeeded"),
  );
  if (failPreserve) {
    await app.store.updateWorkspaceStorage(storage.id, { providerRef: storage.providerRef }, new Date());
  }
  const checkpoint = await app.store.getCheckpoint(result.checkpoint.id);
  if (!checkpoint) throw new Error("missing checkpoint");
  const deleteCheckpoint = (id = checkpoint.id) =>
    app.request(`/v1/checkpoints/${id}`, {
      method: "DELETE",
      headers: { "idempotency-key": `delete-${id}` },
    });
  return { ...app, workspace, storage, marker, checkpoint, deleteCheckpoint };
}

test("deleting the last checkpoint releases the preserved source, including replay", async () => {
  const app = await preservedSource();
  await app.persistence.pruneExpired();
  expect(await readFile(app.marker, "utf8")).toBe("recoverable source");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await app.deleteCheckpoint();
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ state: "succeeded" });
    expect(await app.store.getStorage(app.storage.id)).toMatchObject({ state: "deleted", lastErrorCode: null });
    expect(await app.storageDriver.listStorage()).toEqual([]);
    expect(await app.storageDriver.listCheckpoints()).toEqual([]);
  }
  expect((await app.store.getWorkspace(app.workspace.id))?.state).toBe("preserved");
});

test("retention expiry releases the source after deleting its checkpoint", async () => {
  const app = await preservedSource();
  await app.store.updateCheckpoint(app.checkpoint.id, { expiresAt: new Date(0) }, new Date());
  expect(await app.persistence.pruneExpired()).toMatchObject({ deleted: 1, skipped: 0 });
  expect(await app.storageDriver.listStorage()).toEqual([]);
  expect((await app.store.getStorage(app.storage.id))?.state).toBe("deleted");
});

test("another checkpoint still referencing the source prevents cleanup", async () => {
  const app = await preservedSource();
  const other = await app.store.insertCheckpoint({ ...app.checkpoint, id: randomUUID(), providerRef: null });
  expect((await app.deleteCheckpoint()).status).toBe(202);
  await app.persistence.pruneExpired();
  expect(await readFile(app.marker, "utf8")).toBe("recoverable source");
  expect((await app.deleteCheckpoint(other.id)).status).toBe(202);
  expect(await app.storageDriver.listStorage()).toEqual([]);
});

test("an active operation blocks cleanup and a later sweep retries it", async () => {
  const app = await preservedSource();
  const now = new Date();
  const operationId = randomUUID();
  await app.store.insertOperation({
    id: operationId,
    principalId: app.principal.id,
    kind: "verify",
    state: "running",
    idempotencyKey: "active-verification",
    requestDigest: "fixture",
    workspaceId: app.workspace.id,
    checkpointId: app.checkpoint.id,
    resultWorkspaceId: null,
    reasonCode: null,
    attemptCount: 1,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  });
  expect((await app.deleteCheckpoint()).status).toBe(202);
  await app.persistence.pruneExpired();
  expect(await readFile(app.marker, "utf8")).toBe("recoverable source");
  await app.store.updateOperation(operationId, { state: "succeeded", completedAt: now }, now);
  await app.persistence.pruneExpired();
  expect(await app.storageDriver.listStorage()).toEqual([]);
});

test("a provider still using the source prevents cleanup", async () => {
  const app = await preservedSource();
  const launch = app.driver.created[0];
  if (!launch) throw new Error("missing launch");
  const provider = await app.driver.create(launch);
  expect((await app.deleteCheckpoint()).status).toBe(202);
  expect(await readFile(app.marker, "utf8")).toBe("recoverable source");
  await app.driver.remove(provider);
  await app.persistence.pruneExpired();
  expect(await app.storageDriver.listStorage()).toEqual([]);
});

test("failed preservation keeps its last recoverable allocation", async () => {
  const app = await preservedSource(true);
  expect((await app.store.getWorkspace(app.workspace.id))?.state).toBe("failed");
  expect((await app.deleteCheckpoint()).status).toBe(202);
  await app.persistence.pruneExpired();
  expect(await readFile(app.marker, "utf8")).toBe("recoverable source");
});

test("a failed storage deletion is recorded and retried from durable metadata", async () => {
  const app = await preservedSource();
  // An invalid persisted reference makes the real filesystem driver reject deletion.
  await app.store.updateWorkspaceStorage(
    app.storage.id,
    {
      providerRef: { ...app.storage.providerRef, root: "/invalid-allocation" },
    },
    new Date(),
  );
  expect((await app.deleteCheckpoint()).status).toBe(202);
  expect(await app.store.getStorage(app.storage.id)).toMatchObject({
    state: "retained",
    lastErrorCode: "storage_cleanup_failed",
    deletedAt: null,
  });
  expect(await readFile(app.marker, "utf8")).toBe("recoverable source");
  await app.store.updateWorkspaceStorage(app.storage.id, { providerRef: app.storage.providerRef }, new Date());
  await app.persistence.pruneExpired();
  expect(await app.storageDriver.listStorage()).toEqual([]);
  expect(await app.store.getStorage(app.storage.id)).toMatchObject({ state: "deleted", lastErrorCode: null });
});

test.each([false, true])(
  "a sweep repairs old deleted-checkpoint metadata (directory already gone: %s)",
  async (gone) => {
    const app = await preservedSource();
    await app.storageDriver.deleteCheckpoint(app.checkpoint.providerRef as StorageRef);
    await app.store.updateCheckpoint(app.checkpoint.id, { state: "deleted", deletedAt: new Date() }, new Date());
    if (gone) await app.storageDriver.deleteStorage(app.storage.providerRef as StorageRef);
    expect((await app.store.getStorage(app.storage.id))?.state).toBe("retained");
    await app.persistence.pruneExpired();
    expect((await app.store.getStorage(app.storage.id))?.state).toBe("deleted");
    expect(await app.storageDriver.listStorage()).toEqual([]);
  },
);
