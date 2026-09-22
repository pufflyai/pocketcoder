import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { snapshotOf } from "@pstdio/pocketcoder-contracts";
import { waitFor } from "./persistence-support.test";
import { failedAllocation } from "./purge-support.test";

test("purge removes failed allocations without checkpoints and covered database content before teardown", async () => {
  const app = await failedAllocation();
  const response = await app.purge();
  expect(response.status).toBe(202);
  const operation = (await response.json()) as { id: string };
  await waitFor(async () => (await app.store.getOperation(operation.id))?.state === "succeeded");
  expect(await app.storageDriver.listStorage()).toEqual([]);
  expect(await app.storageDriver.listCheckpoints()).toEqual([]);
  expect(await app.store.readLogs(app.workspace.id, 0, 100)).toEqual([]);
  expect(await app.store.listOutputs(app.workspace.id)).toEqual([]);
  expect(await app.store.readConversation(app.workspace.id, 0, 100)).toEqual([]);
  expect(await app.store.getWorkspace(app.workspace.id)).toMatchObject({ failureLogTail: null, outputs: {} });
  expect(await (await app.purge()).json()).toMatchObject({ id: operation.id, kind: "purge", state: "succeeded" });
});

test("purge keeps failed deletion pending, preserves its target and retries the same operation", async () => {
  const app = await failedAllocation();
  await app.store.updateWorkspaceStorage(
    app.storage.id,
    { providerRef: { ...app.storage.providerRef, root: "/invalid-allocation" } },
    new Date(),
  );
  const response = await app.purge();
  expect(response.status).toBe(202);
  const operation = (await response.json()) as { id: string };
  await waitFor(async () => (await app.store.getOperation(operation.id))?.reasonCode === "purge_storage_unavailable");
  expect(await app.store.getOperation(operation.id)).toMatchObject({ state: "pending", completedAt: null });
  expect(await readFile(app.marker, "utf8")).toBe("synthetic retained content");
  await app.store.updateWorkspaceStorage(app.storage.id, { providerRef: app.storage.providerRef }, new Date());
  await app.purge();
  await waitFor(async () => (await app.store.getOperation(operation.id))?.state === "succeeded");
  expect(await app.storageDriver.listStorage()).toEqual([]);
});

test("accepted purge fences delayed content and new copies while deletion is pending", async () => {
  const app = await failedAllocation();
  await app.store.updateWorkspaceStorage(
    app.storage.id,
    { providerRef: { ...app.storage.providerRef, root: "/invalid-allocation" } },
    new Date(),
  );
  expect((await app.purge()).status).toBe(202);
  const at = new Date();
  await expect(
    app.store.appendConversationMessage({
      workspaceId: app.workspace.id,
      messageId: "late",
      role: "user",
      content: "late transcript",
      metadata: {},
      occurredAt: at,
      createdAt: at,
    }),
  ).rejects.toBeDefined();
  await expect(
    app.store.appendOutput({
      workspaceId: app.workspace.id,
      seq: 0,
      name: "late",
      value: "late output",
      occurredAt: at,
    }),
  ).rejects.toBeDefined();
  await app.store.appendLogs(app.workspace.id, [
    { stream: "stdout", occurredAt: at, content: new TextEncoder().encode("late log") },
  ]);
  expect(await app.store.readLogs(app.workspace.id, 0, 100)).toHaveLength(1);
  const response = await app.request(`/v1/workspaces/${app.workspace.id}/preserve`, {
    method: "POST",
    headers: { "idempotency-key": "late-preserve" },
    body: "{}",
  });
  expect(response.status).toBe(409);
});

test("new recovery identity rechecks restored physical storage instead of replaying old success", async () => {
  const app = await failedAllocation();
  const operation = (await (await app.purge()).json()) as { id: string };
  await waitFor(async () => (await app.store.getOperation(operation.id))?.state === "succeeded");
  await app.storageDriver.allocate({
    storageId: app.storage.id,
    workspaceId: app.workspace.id,
    mounts: app.storage.mountManifest,
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
  });
  await writeFile(app.marker, "restored content");
  expect(await (await app.purge()).json()).toMatchObject({ id: operation.id, state: "succeeded" });
  expect(await readFile(app.marker, "utf8")).toBe("restored content");
  const replay = (await (await app.purge("recovery-execution")).json()) as { id: string };
  expect(replay.id).not.toBe(operation.id);
  await waitFor(async () => (await app.store.getOperation(replay.id))?.state === "succeeded");
  expect(await app.storageDriver.listStorage()).toEqual([]);
});

test("purge removes an interrupted checkpoint copy with no published reference", async () => {
  const app = await failedAllocation();
  const now = new Date();
  const id = crypto.randomUUID();
  await app.store.insertCheckpoint({
    id,
    workspaceId: app.workspace.id,
    principalId: app.principal.id,
    storageId: app.storage.id,
    parentCheckpointId: null,
    state: "failed",
    reasonCode: "checkpoint_failed",
    providerKind: "filesystem",
    providerRef: null,
    templateSnapshot: snapshotOf(app.parsed),
    templateDigest: app.parsed.digest,
    sourceProvenance: null,
    manifest: null,
    manifestDigest: null,
    logicalBytes: null,
    storedBytes: null,
    fileCount: null,
    conversationRestore: "filesystem_only",
    label: null,
    createdAt: now,
    updatedAt: now,
    readyAt: null,
    expiresAt: null,
    deletedAt: null,
  });
  const path = join(String(app.storage.providerRef.root), "..", "..", "checkpoints", `.creating-${id}`);
  await mkdir(path, { recursive: true });
  const marker = join(path, "partial-copy");
  await writeFile(marker, "synthetic partial checkpoint");
  const operation = (await (await app.purge()).json()) as { id: string };
  await waitFor(async () => (await app.store.getOperation(operation.id))?.state === "succeeded");
  expect(await Bun.file(marker).exists()).toBe(false);
});
