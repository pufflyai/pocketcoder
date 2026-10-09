import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { insertTestWorkspace } from "../../test-fixtures";
import { checkpointTransferFixture } from "./transfer-fixture.test";

async function fixture() {
  const f = await checkpointTransferFixture();
  const now = new Date();
  const upload = await f.store.checkpointTransfers.grantUpload(
    f.input,
    () => f.capacity,
    () => {},
  );
  await f.context.db
    .update(f.context.tables.checkpointTransfers)
    .set({
      state: "complete",
      grantDigest: null,
      completedAt: now,
      archiveDigest: `sha256:${"b".repeat(64)}`,
      storedBytes: 3072,
      summary: {
        mounts: f.input.header.mounts,
        manifest_digest: `sha256:${"c".repeat(64)}`,
        content_digest: `sha256:${"d".repeat(64)}`,
      },
    })
    .where(eq(f.context.tables.checkpointTransfers.id, upload.id));
  await f.store.updateCheckpoint(f.checkpoint.id, { state: "ready", readyAt: now }, now);
  const destination = await insertTestWorkspace(f, "checkpoint-destination");
  const sourceStorage = await f.store.getStorage(f.checkpoint.storageId);
  if (!sourceStorage) throw new Error("Source storage missing");
  await f.store.insertWorkspaceStorage({
    ...sourceStorage,
    id: randomUUID(),
    workspaceId: destination.id,
    state: "restoring",
  });
  await f.store.transition(destination.id, { from: ["queued"], to: "provisioning", at: now });
  await f.store.transition(destination.id, { from: ["provisioning"], to: "connected", at: now });
  await f.context.db
    .update(f.context.tables.workspaces)
    .set({
      connectionEpoch: 5,
      restoredFromCheckpointId: f.checkpoint.id,
      originWorkspaceId: f.workspace.id,
      launchMode: "restore",
    })
    .where(eq(f.context.tables.workspaces.id, destination.id));
  const operationId = randomUUID();
  await f.store.insertOperation({
    id: operationId,
    principalId: f.principal.id,
    kind: "restore",
    state: "running",
    idempotencyKey: operationId,
    requestDigest: "restore",
    workspaceId: f.workspace.id,
    checkpointId: f.checkpoint.id,
    resultWorkspaceId: destination.id,
    reasonCode: null,
    attemptCount: 1,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  });
  const input = {
    id: randomUUID(),
    operationId,
    checkpointId: f.checkpoint.id,
    workspaceId: destination.id,
    connectionEpoch: 5,
    grantDigest: Buffer.alloc(32, 11),
    expiresAt: new Date(Date.now() + 20_000),
  };
  return { ...f, destination, input };
}

test("download grant binds new destination and retains original source header", async () => {
  const f = await fixture();
  try {
    const grant = await f.store.checkpointTransfers.grantDownload(f.input, () => {});
    expect(grant.workspaceId).toBe(f.destination.id);
    expect(grant.declaredHeader?.workspace_id).toBe(f.workspace.id);
    expect(grant.reservationId).toBeNull();
    const claim = { ...f.input, direction: "download" as const };
    await expect(f.store.checkpointTransfers.claim(claim, () => {})).resolves.toHaveProperty("state", "streaming");
    await expect(f.store.checkpointTransfers.claim(claim, () => {})).rejects.toThrow("authority");
  } finally {
    await f.dispose();
  }
});

test.each(["source", "operation", "epoch", "expired", "purge"])(
  "download refuses %s authority before consuming grant",
  async (failure) => {
    const f = await fixture();
    try {
      await f.store.checkpointTransfers.grantDownload(f.input, () => {});
      const claim = { ...f.input, direction: "download" as const };
      if (failure === "source") claim.workspaceId = f.workspace.id;
      if (failure === "operation") claim.operationId = randomUUID();
      if (failure === "epoch") claim.connectionEpoch++;
      if (failure === "expired")
        await f.context.db
          .update(f.context.tables.checkpointTransfers)
          .set({ expiresAt: new Date(0) })
          .where(eq(f.context.tables.checkpointTransfers.id, claim.id));
      if (failure === "purge")
        await f.context.db
          .update(f.context.tables.workspaces)
          .set({ purgeRequestedAt: new Date() })
          .where(eq(f.context.tables.workspaces.id, f.workspace.id));
      await expect(f.store.checkpointTransfers.claim(claim, () => {})).rejects.toThrow();
      expect((await f.store.checkpointTransfers.get(claim.id))?.state).toBe("granted");
    } finally {
      await f.dispose();
    }
  },
);

test("download cannot swap the archive receipt after grant delivery", async () => {
  const f = await fixture();
  try {
    await f.store.checkpointTransfers.grantDownload(f.input, () => {});
    await f.context.db
      .update(f.context.tables.checkpointTransfers)
      .set({ archiveDigest: `sha256:${"e".repeat(64)}` })
      .where(eq(f.context.tables.checkpointTransfers.id, f.input.id));
    await expect(f.store.checkpointTransfers.claim({ ...f.input, direction: "download" }, () => {})).rejects.toThrow(
      "publication",
    );
    expect((await f.store.checkpointTransfers.get(f.input.id))?.state).toBe("granted");
  } finally {
    await f.dispose();
  }
});

test.each(["owner", "mounts", "deleted", "state"])(
  "installation refuses changed %s storage authority without completing the transfer",
  async (failure) => {
    const f = await fixture();
    try {
      await f.store.checkpointTransfers.grantDownload(f.input, () => {});
      await f.store.checkpointTransfers.claim({ ...f.input, direction: "download" }, () => {});
      await f.store.checkpointTransfers.downloaded(f.input.id, () => {});
      const storage = await f.store.getWorkspaceStorage(f.destination.id);
      if (!storage) throw new Error("Fixture storage missing");
      if (failure === "owner") {
        const other = await f.store.createPrincipal("other-storage-owner", ["admin"], ["*"]);
        await f.context.db
          .update(f.context.tables.workspaceStorage)
          .set({ principalId: other.id })
          .where(eq(f.context.tables.workspaceStorage.id, storage.id));
      }
      if (failure === "mounts")
        await f.context.db
          .update(f.context.tables.workspaceStorage)
          .set({ mountManifest: [] })
          .where(eq(f.context.tables.workspaceStorage.id, storage.id));
      if (failure === "deleted")
        await f.store.updateWorkspaceStorage(storage.id, { deletedAt: new Date() }, new Date());
      if (failure === "state") await f.store.updateWorkspaceStorage(storage.id, { state: "snapshotting" }, new Date());
      await expect(f.store.checkpointTransfers.installed(f.input.id, () => {})).rejects.toThrow("storage authority");
      expect((await f.store.checkpointTransfers.get(f.input.id))?.state).toBe("validated");
      expect((await f.store.getStorage(storage.id))?.state).not.toBe("ready");
      expect((await f.store.getOperation(f.input.operationId))?.state).toBe("running");
    } finally {
      await f.dispose();
    }
  },
);
