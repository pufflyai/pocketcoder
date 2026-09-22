import { expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { DEFAULT_LIMITS, reconcilePersistence, type StorageRef } from "@pstdio/pocketcoder-runtime-core";
import { buildServer } from "../app";
import { waitFor } from "./persistence-support.test";
import { failedAllocation } from "./purge-support.test";

test("restart resumes the admitted purge without replacing its operation", async () => {
  const app = await failedAllocation();
  await app.store.updateWorkspaceStorage(
    app.storage.id,
    { providerRef: { ...app.storage.providerRef, root: "/invalid-allocation" } },
    new Date(),
  );
  const operation = (await (await app.purge()).json()) as { id: string };
  await waitFor(async () => (await app.store.getOperation(operation.id))?.reasonCode === "purge_storage_unavailable");
  await reconcilePersistence({ store: app.store, driver: app.driver, storageDriver: app.storageDriver });
  expect(await app.store.getOperation(operation.id)).toMatchObject({ state: "pending" });
  const restarted = buildServer({
    store: app.store,
    driver: app.driver,
    storageDriver: app.storageDriver,
    pepper: "persistence-test-pepper",
    limits: DEFAULT_LIMITS,
    workspaceServerUrl: "http://127.0.0.1:0",
  });
  await app.store.updateWorkspaceStorage(app.storage.id, { providerRef: app.storage.providerRef }, new Date());
  expect(await restarted.persistence.retryPurges()).toBe(0);
  expect(await app.store.getOperation(operation.id)).toMatchObject({ state: "succeeded", attemptCount: 2 });
  expect(await app.storageDriver.listStorage()).toEqual([]);
});

test("purge requires ownership and a strict idempotent request", async () => {
  const app = await failedAllocation();
  const stranger = await app.store.createPrincipal("stranger", ["workspaces:purge"], []);
  const key = issueMachineKey("persistence-test-pepper");
  await app.store.insertMachineKey({
    id: key.id,
    secretDigest: key.secretDigest,
    principalId: stranger.id,
    scopes: [],
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    lastUsedAt: null,
  });
  for (const id of [app.workspace.id, crypto.randomUUID()]) {
    const response = await app.request(`/v1/workspaces/${id}/purge`, {
      method: "POST",
      headers: { authorization: `Bearer ${key.token}`, "idempotency-key": "foreign" },
      body: "{}",
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "workspace.not_found" } });
  }
  expect((await app.request(`/v1/workspaces/${app.workspace.id}/purge`, { method: "POST", body: "{}" })).status).toBe(
    400,
  );
  expect(
    (
      await app.request(`/v1/workspaces/${app.workspace.id}/purge`, {
        method: "POST",
        headers: { "idempotency-key": "bad" },
        body: '{"extra":true}',
      })
    ).status,
  ).toBe(400);
  expect((await app.store.getWorkspace(app.workspace.id))?.purgeRequestedAt).toBeNull();
  const first = (await (await app.purge()).json()) as { id: string };
  await waitFor(async () => (await app.store.getOperation(first.id))?.state === "succeeded");
  const other = await app.service.create(
    app.principal,
    { external_id: "other", template: { name: "fixture-persistent" } },
    "other",
  );
  await app.scheduler.tick();
  expect((await app.purge("purge-request", other.workspace.id)).status).toBe(409);
  expect((await app.store.getWorkspace(other.workspace.id))?.purgeRequestedAt).toBeNull();
});

test("purging a source preserves its independently restored descendant and blocks new copies", async () => {
  const app = await failedAllocation();
  const id = crypto.randomUUID();
  const workspace = await app.store.getWorkspace(app.workspace.id);
  if (!workspace) throw new Error("Missing workspace");
  const snapshot = await app.storageDriver.snapshot(
    app.storage.providerRef as StorageRef,
    id,
    app.parsed.digest,
    app.storage.mountManifest,
  );
  const at = new Date();
  await app.store.insertCheckpoint({
    id,
    workspaceId: workspace.id,
    principalId: workspace.principalId,
    storageId: app.storage.id,
    parentCheckpointId: null,
    state: "ready",
    reasonCode: null,
    providerKind: app.storageDriver.kind,
    providerRef: snapshot.ref,
    templateSnapshot: workspace.templateSnapshot,
    templateDigest: workspace.templateDigest,
    sourceProvenance: null,
    manifest: snapshot.manifest,
    manifestDigest: snapshot.manifestDigest,
    logicalBytes: snapshot.manifest.logical_bytes,
    storedBytes: snapshot.storedBytes,
    fileCount: snapshot.manifest.file_count,
    conversationRestore: "filesystem_only",
    label: "synthetic",
    createdAt: at,
    updatedAt: at,
    readyAt: at,
    expiresAt: null,
    deletedAt: null,
  });
  const restored = await app.persistence.restore(app.principal, id, { external_id: "descendant" }, "restore");
  // Race the purge with the already admitted restore. Purge must wait for its copy.
  const operation = (await (await app.purge()).json()) as { id: string };
  await app.scheduler.tick();
  await app.persistence.retryPurges();
  await waitFor(async () => (await app.store.getOperation(operation.id))?.state === "succeeded");
  const child = await app.store.getWorkspaceStorage(restored.workspaceId);
  if (!child) throw new Error("Missing descendant allocation");
  expect(await readFile(join(String(child.providerRef.root), "worktree", "marker.txt"), "utf8")).toBe(
    "synthetic retained content",
  );
  expect((await app.storageDriver.listStorage()).map((row) => row.storageId)).toEqual([child.id]);
  await expect(
    app.persistence.restore(app.principal, id, { external_id: "late-descendant" }, "late-restore"),
  ).rejects.toMatchObject({ code: "checkpoint.not_found" });
});

test("purge cancels a queued restore target without waiting for its fenced admission", async () => {
  const app = await failedAllocation();
  const source = await app.store.getWorkspace(app.workspace.id);
  if (!source) throw new Error("Missing source workspace");
  const childId = crypto.randomUUID();
  await app.store.insertWorkspace({
    ...source,
    id: childId,
    externalId: "queued-restore",
    idempotencyKey: "queued-restore",
    originWorkspaceId: source.id,
    launchMode: "restore",
  });
  const at = new Date();
  const restoreId = crypto.randomUUID();
  await app.store.insertOperation({
    id: restoreId,
    principalId: app.principal.id,
    kind: "restore",
    state: "pending",
    idempotencyKey: "queued-copy",
    requestDigest: "queued-copy",
    workspaceId: app.workspace.id,
    checkpointId: null,
    resultWorkspaceId: childId,
    reasonCode: null,
    attemptCount: 0,
    createdAt: at,
    updatedAt: at,
    completedAt: null,
  });
  const operation = (await (await app.purge("purge-child", childId)).json()) as { id: string };
  await app.persistence.retryPurges();
  expect(await app.store.getOperation(operation.id)).toMatchObject({ state: "succeeded" });
  expect(await app.store.getWorkspace(childId)).toMatchObject({ state: "canceled" });
  expect(await app.store.getOperation(restoreId)).toMatchObject({ state: "failed", reasonCode: "canceled_by_caller" });
  expect(await readFile(app.marker, "utf8")).toBe("synthetic retained content");
});

test("unknown allocation ownership blocks purge before deleting any recorded content", async () => {
  const app = await failedAllocation();
  const unknownId = crypto.randomUUID();
  await app.storageDriver.allocate({
    storageId: unknownId,
    workspaceId: app.workspace.id,
    mounts: app.storage.mountManifest,
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
  });
  const operation = (await (await app.purge()).json()) as { id: string };
  await app.persistence.retryPurges();
  expect(await app.store.getOperation(operation.id)).toMatchObject({
    state: "pending",
    reasonCode: "purge_ownership_unresolved",
    completedAt: null,
  });
  expect((await app.storageDriver.listStorage()).map((row) => row.storageId).sort()).toEqual(
    [app.storage.id, unknownId].sort(),
  );
  expect(await readFile(app.marker, "utf8")).toBe("synthetic retained content");
});

for (const kind of ["checkpoint", "storage"] as const) {
  test(`unattributed physical ${kind} blocks purge until ownership is reconciled`, async () => {
    const app = await failedAllocation();
    const id = crypto.randomUUID();
    const directory = join(
      String(app.storage.providerRef.root),
      "..",
      "..",
      kind === "checkpoint" ? "checkpoints" : "workspaces",
      id,
    );
    await mkdir(directory, { recursive: true });
    const marker = join(directory, "unattributed-content");
    await writeFile(marker, "synthetic content missing from restored database");
    const operation = (await (await app.purge()).json()) as { id: string };
    await app.persistence.retryPurges();
    expect(await app.store.getOperation(operation.id)).toMatchObject({
      state: "pending",
      reasonCode: "purge_ownership_unresolved",
      completedAt: null,
    });
    expect(await Bun.file(app.marker).exists()).toBe(true);
    expect(await Bun.file(marker).exists()).toBe(true);
    await rm(directory, { recursive: true });
    await app.persistence.retryPurges();
    expect(await app.store.getOperation(operation.id)).toMatchObject({ state: "succeeded" });
  });
}

test("Kubernetes object absence without durable termination evidence cannot certify purge", async () => {
  const app = await failedAllocation();
  Object.assign(app.driver, { kind: "kubernetes" });
  await app.store.updateWorkspace(
    app.workspace.id,
    {
      providerKind: "kubernetes",
      providerRef: { id: "missing-job" },
    },
    new Date(),
  );
  const operation = (await (await app.purge()).json()) as { id: string };
  await app.persistence.retryPurges();
  expect(await app.store.getOperation(operation.id)).toMatchObject({
    state: "pending",
    reasonCode: "purge_termination_unresolved",
    completedAt: null,
  });
  expect(await Bun.file(app.marker).exists()).toBe(true);
});
