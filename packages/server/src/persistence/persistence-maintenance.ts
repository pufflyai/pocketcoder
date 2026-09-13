import { randomUUID } from "node:crypto";
import { ApiError, digestOf, type RestoreRequest } from "@pstdio/pocketcoder-contracts";
import type { PrincipalRow, StorageRef, WorkspaceOperationRow } from "@pstdio/pocketcoder-runtime-core";

import type { PersistenceContext } from "./persistence-base";

export class PersistenceMaintenanceService {
  constructor(private readonly context: PersistenceContext) {}
  async storageInventory(): Promise<{
    backend: string;
    storage_count: number;
    checkpoint_count: number;
    unknown_storage: string[];
    unknown_checkpoints: string[];
  }> {
    const driver = this.context.storageDriver();
    const [storage, checkpoints] = await Promise.all([driver.listStorage(), driver.listCheckpoints()]);
    const unknownStorage: string[] = [];
    for (const item of storage) {
      if (!(await this.context.deps.store.getStorage(item.storageId))) {
        unknownStorage.push(item.storageId);
      }
    }
    const unknownCheckpoints: string[] = [];
    for (const item of checkpoints) {
      if (!(await this.context.deps.store.getCheckpoint(item.checkpointId))) {
        unknownCheckpoints.push(item.checkpointId);
      }
    }
    return {
      backend: driver.kind,
      storage_count: storage.length,
      checkpoint_count: checkpoints.length,
      unknown_storage: unknownStorage.sort(),
      unknown_checkpoints: unknownCheckpoints.sort(),
    };
  }

  async pruneExpired(): Promise<{ deleted: number; skipped: number; transcriptsDeleted: number }> {
    const now = this.context.now();
    const transcriptsDeleted = await this.context.deps.store.pruneExpiredConversations(now);
    let deleted = 0;
    let skipped = 0;
    for (const principal of await this.context.deps.store.listPrincipals()) {
      const checkpoints = await this.context.deps.store.listCheckpoints(principal.id, {
        state: "ready",
      });
      for (const checkpoint of checkpoints) {
        if (!checkpoint.expiresAt || checkpoint.expiresAt > now) continue;
        try {
          const operation = await this.delete(principal, checkpoint.id, `retention:${checkpoint.id}`);
          if (operation.state === "succeeded") deleted += 1;
          else skipped += 1;
        } catch (error) {
          skipped += 1;
          this.context.deps.log?.(
            `retention ${checkpoint.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    return { deleted, skipped, transcriptsDeleted };
  }

  async replayRestore(principalId: string, checkpointId: string, body: RestoreRequest, idempotencyKey: string) {
    const requestDigest = digestOf({ checkpoint_id: checkpointId, ...body });
    const replay = await this.context.replayedOperation(
      principalId,
      "restore",
      idempotencyKey,
      requestDigest,
      "This Idempotency-Key was already used with a different restore request.",
    );
    if (!replay) return { requestDigest, result: null };
    this.context.throwFailedOperation(replay);
    const workspace = replay.resultWorkspaceId
      ? await this.context.deps.store.getWorkspace(replay.resultWorkspaceId)
      : null;
    if (!workspace) throw new ApiError("internal.error", "Restore metadata is incomplete.");
    return { requestDigest, result: { workspaceId: workspace.id, operation: replay } };
  }

  async replayInsertedRestore(operationResult: {
    operation: WorkspaceOperationRow;
    created: boolean;
    conflict: boolean;
  }) {
    if (operationResult.created) return null;
    this.context.throwFailedOperation(operationResult.operation);
    const workspace = operationResult.operation.resultWorkspaceId
      ? await this.context.deps.store.getWorkspace(operationResult.operation.resultWorkspaceId)
      : null;
    if (workspace) return { workspaceId: workspace.id, operation: operationResult.operation };
    throw new ApiError("restore.incompatible", "Restore metadata is incomplete.");
  }

  async delete(principal: PrincipalRow, checkpointId: string, idempotencyKey: string): Promise<WorkspaceOperationRow> {
    const requestDigest = digestOf({ checkpoint_id: checkpointId });
    const replay = await this.context.replayedOperation(
      principal.id,
      "delete",
      idempotencyKey,
      requestDigest,
      "Changed delete request.",
    );
    if (replay) return replay;
    const checkpoint = await this.context.getCheckpointOwned(principal, checkpointId);
    const activeRestore = (await this.context.deps.store.listIncompleteOperations()).some(
      (operation) => operation.kind === "restore" && operation.checkpointId === checkpoint.id,
    );
    if (activeRestore) {
      throw new ApiError("checkpoint.in_use", "Checkpoint has an active restore.");
    }
    const now = this.context.now();
    const inserted = await this.context.insertOperation({
      id: randomUUID(),
      principalId: principal.id,
      kind: "delete",
      state: "running",
      idempotencyKey,
      requestDigest,
      workspaceId: checkpoint.workspaceId,
      checkpointId,
      resultWorkspaceId: null,
      reasonCode: null,
      attemptCount: 1,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });
    if (inserted.conflict) throw new ApiError("idempotency.conflict", "Changed delete request.");
    if (!inserted.created) return inserted.operation;
    await this.context.deps.store.updateCheckpoint(checkpoint.id, { state: "deleting" }, now);
    const deleting = await this.context.deps.store.getCheckpoint(checkpoint.id);
    if (deleting) await this.context.emitCheckpointEvent("checkpoint.deleting", deleting);
    try {
      if (checkpoint.providerRef) {
        await this.context.storageDriver().deleteCheckpoint(checkpoint.providerRef as StorageRef);
      }
      const done = this.context.now();
      await this.context.deps.store.updateCheckpoint(checkpoint.id, { state: "deleted", deletedAt: done }, done);
      const deleted = await this.context.deps.store.getCheckpoint(checkpoint.id);
      if (deleted) await this.context.emitCheckpointEvent("checkpoint.deleted", deleted);
      await this.context.deps.store.updateOperation(
        inserted.operation.id,
        { state: "succeeded", completedAt: done },
        done,
      );
    } catch {
      await this.context.failOperation(inserted.operation.id, "checkpoint_failed");
    }
    return (await this.context.deps.store.getOperation(inserted.operation.id)) ?? inserted.operation;
  }
}
