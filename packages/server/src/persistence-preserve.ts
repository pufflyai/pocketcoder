import { randomUUID } from "node:crypto";
import {
  ApiError,
  digestOf,
  type PreserveRequest,
  parseDurationMs,
  type ReasonCode,
} from "@pstdio/pocketcoder-contracts";
import type {
  PrincipalRow,
  WorkspaceCheckpointRow,
  WorkspaceOperationRow,
} from "@pstdio/pocketcoder-runtime-core";
import { PersistencePreserveRunner } from "./persistence-preserve-runner";

export class PreservePersistenceService extends PersistencePreserveRunner {
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
    const workspace = await this.deps.workspaces.getOwned(principal, workspaceId);
    const requestDigest = digestOf({ workspace_id: workspaceId, ...body });
    const replay = await this.replayedOperation(
      principal.id,
      "preserve",
      idempotencyKey,
      requestDigest,
      "This Idempotency-Key was already used with a different preserve request.",
    );
    if (replay) {
      this.throwFailedOperation(replay);
      const checkpoint = replay.checkpointId
        ? await this.deps.store.getCheckpoint(replay.checkpointId)
        : null;
      if (!checkpoint) throw new ApiError("internal.error", "Checkpoint metadata is missing.");
      return { workspaceId, checkpoint, operation: replay };
    }
    if (workspace.templateSnapshot.spec.persistence.mounts.length === 0) {
      throw new ApiError(
        "workspace.persistence_not_enabled",
        "This template does not declare persistent mounts.",
      );
    }
    if (
      body.retention &&
      !principal.scopes.includes("admin") &&
      parseDurationMs(body.retention) >
        parseDurationMs(workspace.templateSnapshot.spec.persistence.checkpoint.retention)
    ) {
      throw new ApiError(
        "validation.invalid",
        "retention may not exceed the template checkpoint policy",
      );
    }
    this.storageDriver();
    const checkpointId = randomUUID();
    const operationId = randomUUID();
    const now = this.now();
    const operationResult = await this.insertOperation({
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
      this.throwFailedOperation(operationResult.operation);
      const existing = operationResult.operation.checkpointId
        ? await this.deps.store.getCheckpoint(operationResult.operation.checkpointId)
        : null;
      if (!existing) throw new ApiError("checkpoint.not_found", "Checkpoint metadata is missing.");
      return {
        workspaceId,
        checkpoint: existing,
        operation: operationResult.operation,
      };
    }
    try {
      await this.assertPreserveAdmission(
        principal.id,
        workspace.templateSnapshot.spec.persistence.mounts.reduce(
          (sum, mount) => sum + mount.maxBytes,
          0,
        ),
      );
    } catch (error) {
      await this.failOperation(operationId, "checkpoint_quota_exceeded");
      throw error;
    }

    const storage = await this.deps.store.getWorkspaceStorage(workspace.id);
    if (storage?.state !== "ready") {
      await this.failOperation(operationId, "checkpoint_storage_lost");
      throw new ApiError(
        "workspace.persistence_not_enabled",
        "Workspace persistent storage is not ready.",
      );
    }
    const retention =
      body.retention ?? workspace.templateSnapshot.spec.persistence.checkpoint.retention;
    const expiresAt = new Date(now.getTime() + parseDurationMs(retention));
    const checkpoint = await this.deps.store.insertCheckpoint({
      id: checkpointId,
      workspaceId: workspace.id,
      principalId: workspace.principalId,
      storageId: storage.id,
      parentCheckpointId: workspace.latestCheckpointId,
      state: "creating",
      reasonCode: null,
      providerKind: this.storageDriver().kind,
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
    await this.deps.store.updateOperation(operationId, { checkpointId: checkpoint.id }, now);
    await this.emitCheckpointEvent("checkpoint.creating", checkpoint);
    const preserving = await this.deps.store.transition(workspace.id, {
      from: ["connected", "ready"],
      to: "preserving",
      reason: transitionReason,
      at: now,
    });
    if (!preserving) {
      await this.deps.store.updateCheckpoint(
        checkpoint.id,
        { state: "failed", reasonCode: "operation_conflict" },
        this.now(),
      );
      await this.failOperation(operationId, "operation_conflict");
      throw new ApiError("operation.conflict", "Another workspace lifecycle operation won.");
    }
    void this.runPreserve(preserving.id, checkpoint.id, operationId).catch((error) => {
      this.deps.log?.(`preserve ${operationId}: ${String(error)}`);
    });
    return {
      workspaceId,
      checkpoint,
      operation:
        (await this.deps.store.getOperation(operationResult.operation.id)) ??
        operationResult.operation,
    };
  }

  async preserveByPolicy(
    workspace: { id: string; principalId: string },
    trigger: "idle" | "deadline" | "clean_exit" | "failure",
  ): Promise<boolean> {
    const principal = (await this.deps.store.listPrincipals()).find(
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
