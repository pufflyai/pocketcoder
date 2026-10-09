import { randomUUID } from "node:crypto";
import { CHECKPOINT_ARCHIVE_FORMAT, digestOf, snapshotOf } from "@pstdio/pocketcoder-contracts";
import { createPGliteFixture, insertTestWorkspace } from "../../test-fixtures";

export async function checkpointTransferFixture() {
  const fixture = await createPGliteFixture("checkpoint-grant", "disk");
  try {
    const workspace = await insertTestWorkspace(fixture, "checkpoint-source");
    const now = new Date();
    await fixture.store.transition(workspace.id, { from: ["queued"], to: "provisioning", at: now });
    await fixture.store.transition(workspace.id, { from: ["provisioning"], to: "connected", at: now });
    await fixture.store.transition(workspace.id, { from: ["connected"], to: "preserving", at: now });
    await fixture.store.updateWorkspace(workspace.id, { connectionEpoch: 3 }, now);
    const storageId = randomUUID();
    await fixture.store.insertWorkspaceStorage({
      id: storageId,
      workspaceId: workspace.id,
      principalId: fixture.principal.id,
      providerKind: "disposable",
      providerRef: {},
      state: "retained",
      mountManifest: fixture.parsed.manifest.spec.persistence.mounts,
      logicalBytes: 0,
      fileCount: 0,
      retainedUntil: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      lastErrorCode: null,
    });
    const checkpoint = await fixture.store.insertCheckpoint({
      id: randomUUID(),
      workspaceId: workspace.id,
      principalId: fixture.principal.id,
      storageId,
      parentCheckpointId: null,
      state: "creating",
      reasonCode: null,
      providerKind: "controller",
      providerRef: null,
      templateSnapshot: snapshotOf(fixture.parsed),
      templateDigest: fixture.parsed.digest,
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
    const operationId = randomUUID();
    await fixture.store.insertOperation({
      id: operationId,
      principalId: fixture.principal.id,
      kind: "preserve",
      state: "running",
      idempotencyKey: operationId,
      requestDigest: digestOf({ checkpointId: checkpoint.id }),
      workspaceId: workspace.id,
      checkpointId: checkpoint.id,
      resultWorkspaceId: null,
      reasonCode: null,
      attemptCount: 1,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });
    const header = {
      format: CHECKPOINT_ARCHIVE_FORMAT as typeof CHECKPOINT_ARCHIVE_FORMAT,
      checkpoint_id: checkpoint.id,
      workspace_id: workspace.id,
      template_digest: fixture.parsed.digest,
      mounts: [{ name: "worktree", logical_bytes: 0, file_count: 0 }],
    };
    const input = {
      retentionLimits: {
        maxCheckpointFiles: 10_000,
        maxRetainedBytes: 1_000_000,
        maxRetainedBytesPerPrincipal: 1_000_000,
        maxCheckpointsPerPrincipal: 100,
      },
      id: randomUUID(),
      operationId,
      checkpointId: checkpoint.id,
      workspaceId: workspace.id,
      connectionEpoch: 3,
      header,
      expectedArchiveBytes: 3072,
      grantDigest: Buffer.alloc(32, 7),
      expiresAt: new Date(Date.now() + 30_000),
      reservationId: randomUUID(),
      reservedBytes: 8192,
      reservedFiles: 6,
    };
    const capacity = {
      workspace: { bytes: 10_000, files: 10 },
      principal: { bytes: 10_000, files: 10 },
      instance: { bytes: 10_000, files: 10 },
      freeDisk: { bytes: 20_000, files: 20, headroomBytes: 10_000, headroomFiles: 10 },
    };
    return { ...fixture, workspace, checkpoint, input, capacity };
  } catch (error) {
    await fixture.dispose();
    throw error;
  }
}
