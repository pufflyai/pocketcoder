import { randomUUID } from "node:crypto";
import {
  ApiError,
  canonicalJson,
  parseDurationMs,
  type RestoreRequest,
} from "@pstdio/pocketcoder-contracts";
import type { PrincipalRow, WorkspaceOperationRow } from "@pstdio/pocketcoder-runtime-core";
import { PersistenceMaintenanceService } from "./persistence-maintenance";
import { templateAuthorized } from "./service";

export class PersistenceRestoreService extends PersistenceMaintenanceService {
  async restore(
    principal: PrincipalRow,
    checkpointId: string,
    body: RestoreRequest,
    idempotencyKey: string,
  ): Promise<{ workspaceId: string; operation: WorkspaceOperationRow }> {
    const replay = await this.replayRestore(principal.id, checkpointId, body, idempotencyKey);
    if (replay.result) return replay.result;
    const { requestDigest } = replay;
    const checkpoint = await this.getCheckpointOwned(principal, checkpointId);
    if (checkpoint.state !== "ready" || !checkpoint.providerRef || !checkpoint.manifest) {
      throw new ApiError("checkpoint.not_ready", "Checkpoint is not ready for restore.");
    }
    if (!templateAuthorized(principal, checkpoint.templateSnapshot.name)) {
      throw new ApiError(
        "restore.template_not_authorized",
        "Principal is no longer authorized for this checkpoint template.",
      );
    }
    if (
      body.launch_input !== undefined &&
      Buffer.byteLength(canonicalJson(body.launch_input)) >
        checkpoint.templateSnapshot.spec.maxLaunchInputBytes
    ) {
      throw new ApiError(
        "validation.invalid",
        `launch_input exceeds the template limit of ${checkpoint.templateSnapshot.spec.maxLaunchInputBytes} bytes.`,
      );
    }
    this.storageDriver();
    const now = this.now();
    const resultWorkspaceId = randomUUID();
    const operationResult = await this.insertOperation({
      id: randomUUID(),
      principalId: principal.id,
      kind: "restore",
      state: "pending",
      idempotencyKey,
      requestDigest,
      workspaceId: checkpoint.workspaceId,
      checkpointId,
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
        "This Idempotency-Key was already used with a different restore request.",
      );
    }
    const operationReplay = await this.replayInsertedRestore(operationResult);
    if (operationReplay) return operationReplay;
    const restoreWorkspaceId = operationResult.operation.resultWorkspaceId ?? resultWorkspaceId;
    const source = checkpoint.sourceProvenance
      ? {
          kind: "git" as const,
          repository: checkpoint.sourceProvenance.repository,
          revision: checkpoint.sourceProvenance.requested_revision,
        }
      : null;
    const template = await this.deps.store.getTemplate(
      checkpoint.templateSnapshot.name,
      checkpoint.templateSnapshot.version,
    );
    if (!template) {
      await this.failOperation(operationResult.operation.id, "image_unavailable");
      throw new ApiError(
        "restore.image_unavailable",
        "The exact checkpoint template snapshot is unavailable.",
      );
    }
    const inserted = await this.deps.store.insertWorkspace(
      {
        id: restoreWorkspaceId,
        principalId: principal.id,
        externalId: body.external_id,
        idempotencyKey: `restore:${operationResult.operation.id}`,
        requestDigest,
        templateId: template.id,
        templateSnapshot: checkpoint.templateSnapshot,
        launchInput: body.launch_input ?? null,
        metadata: body.metadata ?? {},
        deadlineAt: new Date(
          now.getTime() + parseDurationMs(checkpoint.templateSnapshot.spec.timeouts.maxAge),
        ),
        createdAt: now,
        originWorkspaceId: checkpoint.workspaceId,
        restoredFromCheckpointId: checkpoint.id,
        sourceDescriptor: source,
        resolvedSource: checkpoint.sourceProvenance,
        persistenceCapability: checkpoint.conversationRestore,
        launchMode: "restore",
      },
      { maxQueuedWorkspaces: this.deps.maxQueuedWorkspaces },
    );
    if (inserted.kind === "capacity_exceeded") {
      await this.failOperation(operationResult.operation.id, "queue_full");
      throw new ApiError("capacity.queue_full", "The workspace queue is full; retry later.");
    }
    if (inserted.kind === "conflict") {
      await this.failOperation(operationResult.operation.id, "operation_conflict");
      throw new ApiError(
        inserted.conflict === "external_id"
          ? "workspace.external_id_conflict"
          : "idempotency.conflict",
        "The restore request conflicts with an existing workspace.",
      );
    }
    await this.deps.store.updateOperation(
      operationResult.operation.id,
      { resultWorkspaceId: inserted.workspace.id },
      now,
    );
    await this.deps.store.appendEvent(
      checkpoint.workspaceId,
      "workspace.restore_queued",
      {
        id: randomUUID(),
        type: "workspace.restore_queued",
        occurred_at: now.toISOString(),
        origin_workspace_id: checkpoint.workspaceId,
        checkpoint_id: checkpoint.id,
        result_workspace_id: inserted.workspace.id,
      },
      now,
    );
    void this.deps.scheduler.tick().catch(() => {});
    return {
      workspaceId: inserted.workspace.id,
      operation:
        (await this.deps.store.getOperation(operationResult.operation.id)) ??
        operationResult.operation,
    };
  }
}
