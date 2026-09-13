import { randomUUID } from "node:crypto";
import {
  ApiError,
  digestOf,
  type PreserveRequest,
  parseDurationMs,
  type ReasonCode,
} from "@pstdio/pocketcoder-contracts";
import type { PrincipalRow, WorkspaceCheckpointRow, WorkspaceOperationRow } from "@pstdio/pocketcoder-runtime-core";

import type { PersistenceContext } from "./persistence-base";
import type { PersistencePreserveRunner } from "./persistence-preserve-runner";

export class PreservePersistenceService {
  constructor(
    private readonly context: PersistenceContext,
    private readonly preserveRunner: PersistencePreserveRunner,
  ) {}
  async preserve(
    principal: PrincipalRow,
    workspaceId: string,
    body: PreserveRequest,
    idempotencyKey: string,
    transitionReason: ReasonCode = "preserve_requested",
  ): Promise<{
    workspaceId: string;
    checkpoint: WorkspaceCheckpointRow;
    operation: WorkspaceOperationRow;
  }> {
    const workspace = await this.context.deps.workspaces.getOwned(principal, workspaceId);
    const requestDigest = digestOf({ workspace_id: workspaceId, ...body });
    const replay = await this.context.replayedOperation(
      principal.id,
      "preserve",
      idempotencyKey,
      requestDigest,
      "This Idempotency-Key was already used with a different preserve request.",
    );
    if (replay) {
      this.context.throwFailedOperation(replay);
      const checkpoint = replay.checkpointId ? await this.context.deps.store.getCheckpoint(replay.checkpointId) : null;
      if (!checkpoint) throw new ApiError("internal.error", "Checkpoint metadata is missing.");
      return { workspaceId, checkpoint, operation: replay };
    }
    if (workspace.templateSnapshot.spec.persistence.mounts.length === 0) {
      throw new ApiError("workspace.persistence_not_enabled", "This template does not declare persistent mounts.");
    }
    if (
      body.retention &&
      !principal.scopes.includes("admin") &&
      parseDurationMs(body.retention) >
        parseDurationMs(workspace.templateSnapshot.spec.persistence.checkpoint.retention)
    ) {
      throw new ApiError("validation.invalid", "retention may not exceed the template checkpoint policy");
    }
    this.context.storageDriver();
    const checkpointId = randomUUID();
    const operationId = randomUUID();
    const now = this.context.now();
    const operationResult = await this.context.insertOperation({
      id: operationId,
      principalId: principal.id,
      kind: "preserve",
      state: "pending",
      idempotencyKey,
      requestDigest,
      workspaceId,
      checkpointId: null,
      resultWorkspaceId: null,
      reasonCode: null,
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });
    if (operationResult.conflict) {
      throw new ApiError(
        "idempotency.conflict",
        "This Idempotency-Key was already used with a different preserve request.",
      );
    }
    if (!operationResult.created) {
      this.context.throwFailedOperation(operationResult.operation);
      const existing = operationResult.operation.checkpointId
        ? await this.context.deps.store.getCheckpoint(operationResult.operation.checkpointId)
        : null;
      if (!existing) throw new ApiError("checkpoint.not_found", "Checkpoint metadata is missing.");
      return {
        workspaceId,
        checkpoint: existing,
        operation: operationResult.operation,
      };
    }
    try {
      await this.context.assertPreserveAdmission(
        principal.id,
        workspace.templateSnapshot.spec.persistence.mounts.reduce((sum, mount) => sum + mount.maxBytes, 0),
      );
    } catch (error) {
      await this.context.failOperation(operationId, "checkpoint_quota_exceeded");
      throw error;
    }

    const storage = await this.context.deps.store.getWorkspaceStorage(workspace.id);
    if (storage?.state !== "ready") {
      await this.context.failOperation(operationId, "checkpoint_storage_lost");
      throw new ApiError("workspace.persistence_not_enabled", "Workspace persistent storage is not ready.");
    }
    const retention = body.retention ?? workspace.templateSnapshot.spec.persistence.checkpoint.retention;
    const expiresAt = new Date(now.getTime() + parseDurationMs(retention));
    const checkpoint = await this.context.deps.store.insertCheckpoint({
      id: checkpointId,
      workspaceId: workspace.id,
      principalId: workspace.principalId,
      storageId: storage.id,
      parentCheckpointId: workspace.latestCheckpointId,
      state: "creating",
      reasonCode: null,
      providerKind: this.context.storageDriver().kind,
      providerRef: null,
      templateSnapshot: workspace.templateSnapshot,
      templateDigest: workspace.templateDigest,
      sourceProvenance: workspace.resolvedSource,
      manifest: null,
      manifestDigest: null,
      logicalBytes: null,
      storedBytes: null,
      fileCount: null,
      conversationRestore: workspace.persistenceCapability,
      label: body.label ?? null,
      createdAt: now,
      updatedAt: now,
      readyAt: null,
      expiresAt,
      deletedAt: null,
    });
    await this.context.deps.store.updateOperation(operationId, { checkpointId: checkpoint.id }, now);
    await this.context.emitCheckpointEvent("checkpoint.creating", checkpoint);
    const preserving = await this.context.deps.store.transition(workspace.id, {
      from: ["connected", "ready"],
      to: "preserving",
      reason: transitionReason,
      at: now,
    });
    if (!preserving) {
      await this.context.deps.store.updateCheckpoint(
        checkpoint.id,
        { state: "failed", reasonCode: "operation_conflict" },
        this.context.now(),
      );
      await this.context.failOperation(operationId, "operation_conflict");
      throw new ApiError("operation.conflict", "Another workspace lifecycle operation won.");
    }
    void this.preserveRunner.runPreserve(preserving.id, checkpoint.id, operationId).catch((error) => {
      this.context.deps.log?.(`preserve ${operationId}: ${String(error)}`);
    });
    return {
      workspaceId,
      checkpoint,
      operation:
        (await this.context.deps.store.getOperation(operationResult.operation.id)) ?? operationResult.operation,
    };
  }

  async preserveByPolicy(
    workspace: { id: string; principalId: string },
    trigger: "idle" | "deadline" | "clean_exit" | "failure",
  ): Promise<boolean> {
    const principal = (await this.context.deps.store.listPrincipals()).find(
      (candidate) => candidate.id === workspace.principalId,
    );
    if (!principal || principal.disabledAt) return false;
    await this.preserve(
      principal,
      workspace.id,
      { label: `policy:${trigger}` },
      `policy:${trigger}:${workspace.id}`,
      "preserved_by_policy",
    );
    return true;
  }
}
