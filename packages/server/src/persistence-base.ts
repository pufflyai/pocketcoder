import { randomUUID } from "node:crypto";
import { ApiError, type ErrorCode, type OperationKind } from "@pstdio/pocketcoder-contracts";
import type {
  AuthStore,
  ConversationStore,
  OutboxStore,
  OutputStore,
  PersistenceStore,
  PrincipalRow,
  Scheduler,
  TemplateStore,
  WorkspaceCheckpointRow,
  WorkspaceDriver,
  WorkspaceOperationRow,
  WorkspaceStorageDriver,
  WorkspaceStore,
} from "@pstdio/pocketcoder-runtime-core";
import { OperationCapacityExceededError } from "@pstdio/pocketcoder-runtime-core";
import type { Hub } from "./hub";
import type { WorkspaceService } from "./service";

export interface PersistenceServiceDeps {
  store: AuthStore &
    TemplateStore &
    WorkspaceStore &
    PersistenceStore &
    OutputStore &
    ConversationStore &
    OutboxStore;
  scheduler: Scheduler;
  driver: WorkspaceDriver;
  storageDriver?: WorkspaceStorageDriver;
  hub: Hub;
  workspaces: WorkspaceService;
  maxQueuedWorkspaces: number;
  now?: () => Date;
  log?: (message: string) => void;
  limits?: PersistenceLimits;
}

export interface PersistenceLimits {
  maxRetainedBytes: number;
  maxRetainedBytesPerPrincipal: number;
  maxCheckpointsPerPrincipal: number;
  maxCheckpointFiles: number;
  maxConcurrentOperations: number;
}

export const DEFAULT_PERSISTENCE_LIMITS: PersistenceLimits = {
  maxRetainedBytes: 500 * 1024 ** 3,
  maxRetainedBytesPerPrincipal: 100 * 1024 ** 3,
  maxCheckpointsPerPrincipal: 100,
  maxCheckpointFiles: 1_000_000,
  maxConcurrentOperations: 4,
};

export type SnapshotResult = Awaited<ReturnType<WorkspaceStorageDriver["snapshot"]>>;

export function toCheckpointResource(row: WorkspaceCheckpointRow) {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    state: row.state,
    reason_code: row.reasonCode,
    template: {
      name: row.templateSnapshot.name,
      version: row.templateSnapshot.version,
      digest: row.templateDigest,
    },
    manifest_digest: row.manifestDigest,
    logical_bytes: row.logicalBytes,
    stored_bytes: row.storedBytes,
    file_count: row.fileCount,
    mounts: row.templateSnapshot.spec.persistence.mounts.map((mount) => mount.name),
    conversation_restore: row.conversationRestore,
    label: row.label,
    created_at: row.createdAt.toISOString(),
    ready_at: row.readyAt?.toISOString() ?? null,
    expires_at: row.expiresAt?.toISOString() ?? null,
  };
}

export function toOperationResource(row: WorkspaceOperationRow) {
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    workspace_id: row.workspaceId,
    checkpoint_id: row.checkpointId,
    result_workspace_id: row.resultWorkspaceId,
    reason_code: row.reasonCode,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    completed_at: row.completedAt?.toISOString() ?? null,
  };
}

export class PersistenceBase {
  constructor(protected readonly deps: PersistenceServiceDeps) {}

  protected now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  protected storageDriver(): WorkspaceStorageDriver {
    if (!this.deps.storageDriver) {
      throw new ApiError(
        "workspace.persistence_not_enabled",
        "Persistent storage is not configured on this deployment.",
      );
    }
    return this.deps.storageDriver;
  }

  protected limits(): PersistenceLimits {
    return this.deps.limits ?? DEFAULT_PERSISTENCE_LIMITS;
  }

  protected async replayedOperation(
    principalId: string,
    kind: OperationKind,
    idempotencyKey: string,
    requestDigest: string,
    conflictMessage: string,
  ) {
    const operation = await this.deps.store.getOperationByIdempotency(
      principalId,
      kind,
      idempotencyKey,
    );
    if (!operation) return null;
    if (operation.requestDigest !== requestDigest) {
      throw new ApiError("idempotency.conflict", conflictMessage);
    }
    return operation;
  }

  protected throwFailedOperation(operation: WorkspaceOperationRow): void {
    if (operation.state !== "failed") return;
    const failures: Partial<Record<OperationKind, Record<string, [ErrorCode, string]>>> = {
      preserve: {
        checkpoint_quota_exceeded: ["checkpoint.quota_exceeded", "Checkpoint quota exceeded."],
        checkpoint_storage_lost: [
          "workspace.persistence_not_enabled",
          "Workspace persistent storage is not ready.",
        ],
      },
      restore: {
        image_unavailable: [
          "restore.image_unavailable",
          "The exact checkpoint template snapshot is unavailable.",
        ],
        queue_full: ["capacity.queue_full", "The workspace queue is full; retry later."],
        operation_conflict: [
          "workspace.external_id_conflict",
          "The restore request conflicts with an existing workspace.",
        ],
      },
      verify: {
        checkpoint_corrupt: ["checkpoint.corrupt", "Checkpoint integrity verification failed."],
      },
    };
    const failure = operation.reasonCode ? failures[operation.kind]?.[operation.reasonCode] : null;
    if (failure) throw new ApiError(...failure);
    throw new ApiError("internal.error", "The persistence operation failed.");
  }

  async getCheckpointOwned(principal: PrincipalRow, id: string): Promise<WorkspaceCheckpointRow> {
    const row = await this.deps.store.getCheckpoint(id);
    if (!row || row.principalId !== principal.id || row.state === "deleted") {
      throw new ApiError("checkpoint.not_found", "Unknown checkpoint.");
    }
    return row;
  }
  protected async failOperation(id: string, reasonCode: string): Promise<void> {
    const at = this.now();
    await this.deps.store.updateOperation(id, { state: "failed", reasonCode, completedAt: at }, at);
  }

  protected async insertOperation(row: WorkspaceOperationRow) {
    try {
      return await this.deps.store.insertOperation(row, {
        maxIncompleteOperations: this.limits().maxConcurrentOperations,
      });
    } catch (error) {
      if (error instanceof OperationCapacityExceededError) {
        throw new ApiError(
          "storage.capacity_exhausted",
          "Too many checkpoint operations are already running.",
        );
      }
      throw error;
    }
  }

  protected async assertPreserveAdmission(
    principalId: string,
    declaredBytes: number,
  ): Promise<void> {
    const [global, principal] = await Promise.all([
      this.deps.store.checkpointUsage(null),
      this.deps.store.checkpointUsage(principalId),
    ]);
    const limits = this.limits();
    if (
      principal.count >= limits.maxCheckpointsPerPrincipal ||
      global.logicalBytes + declaredBytes > limits.maxRetainedBytes ||
      principal.logicalBytes + declaredBytes > limits.maxRetainedBytesPerPrincipal
    ) {
      throw new ApiError(
        "checkpoint.quota_exceeded",
        "Checkpoint admission exceeds deployment or principal storage limits.",
      );
    }
  }

  protected async assertMeasuredCheckpoint(
    principalId: string,
    logicalBytes: number,
    fileCount: number,
  ): Promise<void> {
    const [global, principal] = await Promise.all([
      this.deps.store.checkpointUsage(null),
      this.deps.store.checkpointUsage(principalId),
    ]);
    const limits = this.limits();
    if (
      fileCount > limits.maxCheckpointFiles ||
      global.logicalBytes + logicalBytes > limits.maxRetainedBytes ||
      principal.logicalBytes + logicalBytes > limits.maxRetainedBytesPerPrincipal
    ) {
      throw new Error("checkpoint.quota_exceeded");
    }
  }

  protected async emitCheckpointEvent(
    type:
      | "checkpoint.creating"
      | "checkpoint.ready"
      | "checkpoint.failed"
      | "checkpoint.deleting"
      | "checkpoint.deleted",
    row: WorkspaceCheckpointRow,
  ): Promise<void> {
    const at = this.now();
    await this.deps.store.appendEvent(
      row.workspaceId,
      type,
      {
        id: randomUUID(),
        type,
        occurred_at: at.toISOString(),
        checkpoint: {
          id: row.id,
          workspace_id: row.workspaceId,
          state: row.state,
          reason_code: row.reasonCode,
          logical_bytes: row.logicalBytes,
          file_count: row.fileCount,
          expires_at: row.expiresAt?.toISOString() ?? null,
        },
      },
      at,
    );
  }
}
