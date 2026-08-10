import type { CheckpointRef, ProviderRef, WorkspaceDriver, WorkspaceStorageDriver } from "./driver";
import type { MetricSink } from "./metrics";
import { measureReconciliation } from "./reconciliation-metrics";
import type {
  Store,
  WorkspaceCheckpointRow,
  WorkspaceOperationRow,
  WorkspaceRow,
  WorkspaceStorageRow,
} from "./types";

export interface PersistenceReconcileDeps {
  store: Store;
  driver: WorkspaceDriver;
  storageDriver?: WorkspaceStorageDriver;
  now?: () => Date;
  log?: (message: string) => void;
  metrics?: MetricSink;
}

interface OperationContext {
  checkpoint: WorkspaceCheckpointRow | null;
  workspace: WorkspaceRow | null;
  storage: WorkspaceStorageRow | null;
}

async function loadOperationContext(
  deps: PersistenceReconcileDeps,
  operation: WorkspaceOperationRow,
): Promise<OperationContext> {
  const checkpoint = operation.checkpointId
    ? await deps.store.getCheckpoint(operation.checkpointId)
    : null;
  const workspaceId = operation.resultWorkspaceId ?? operation.workspaceId;
  const workspace = workspaceId ? await deps.store.getWorkspace(workspaceId) : null;
  const storage = workspace
    ? await deps.store.getWorkspaceStorage(workspace.id)
    : checkpoint
      ? await deps.store.getStorage(checkpoint.storageId)
      : null;
  return { checkpoint, workspace, storage };
}

async function failOperation(
  deps: PersistenceReconcileDeps,
  operation: WorkspaceOperationRow,
  reasonCode: "restore_failed" | "checkpoint_storage_lost" | "checkpoint_failed",
  now: Date,
): Promise<void> {
  await deps.store.updateOperation(
    operation.id,
    { state: "failed", reasonCode, completedAt: now },
    now,
  );
}

async function reconcileVerification(
  deps: PersistenceReconcileDeps,
  operation: WorkspaceOperationRow,
  checkpoint: WorkspaceCheckpointRow,
  now: Date,
): Promise<void> {
  if (checkpoint.state !== "ready" || !checkpoint.providerRef || !checkpoint.manifest) return;
  try {
    await deps.storageDriver?.verifyCheckpoint(
      checkpoint.providerRef as CheckpointRef,
      checkpoint.manifest,
    );
    await deps.store.updateOperation(operation.id, { state: "succeeded", completedAt: now }, now);
  } catch {
    await deps.store.updateOperation(
      operation.id,
      { state: "failed", reasonCode: "checkpoint_corrupt", completedAt: now },
      now,
    );
  }
}

async function reconcileDeletion(
  deps: PersistenceReconcileDeps,
  operation: WorkspaceOperationRow,
  checkpoint: WorkspaceCheckpointRow,
  now: Date,
): Promise<void> {
  if (!checkpoint.providerRef) return;
  try {
    await deps.storageDriver?.deleteCheckpoint(checkpoint.providerRef as CheckpointRef);
    await deps.store.updateCheckpoint(checkpoint.id, { state: "deleted", deletedAt: now }, now);
    await deps.store.updateOperation(operation.id, { state: "succeeded", completedAt: now }, now);
  } catch {
    // Leave deleting/running for the next restart/operator retry.
  }
}

async function cleanupProvider(
  deps: PersistenceReconcileDeps,
  workspace: WorkspaceRow | null,
): Promise<void> {
  if (!workspace?.providerRef) return;
  await deps.driver.stop(workspace.providerRef as ProviderRef, 1).catch(() => {});
  await deps.driver.remove(workspace.providerRef as ProviderRef).catch(() => {});
}

async function completePreserve(
  deps: PersistenceReconcileDeps,
  operation: WorkspaceOperationRow,
  checkpoint: WorkspaceCheckpointRow,
  workspace: WorkspaceRow,
  now: Date,
): Promise<void> {
  await cleanupProvider(deps, workspace);
  await deps.store.updateWorkspace(workspace.id, { latestCheckpointId: checkpoint.id }, now);
  await deps.store.transition(workspace.id, {
    from: ["preserving"],
    to: "preserved",
    reason: "checkpoint_created",
    at: now,
    patch: { latestCheckpointId: checkpoint.id },
  });
  await deps.store.updateOperation(operation.id, { state: "succeeded", completedAt: now }, now);
}

async function failPreserve(
  deps: PersistenceReconcileDeps,
  operation: WorkspaceOperationRow,
  context: OperationContext,
  now: Date,
): Promise<void> {
  const { checkpoint, workspace, storage } = context;
  if (!checkpoint) return;
  if (storage) {
    await deps.store.updateWorkspaceStorage(
      storage.id,
      { state: "retained", lastErrorCode: "checkpoint_failed" },
      now,
    );
  }
  await cleanupProvider(deps, workspace);
  if (checkpoint.state === "creating") {
    await deps.store.updateCheckpoint(
      checkpoint.id,
      { state: "failed", reasonCode: "checkpoint_failed" },
      now,
    );
  }
  if (workspace?.state === "preserving") {
    await deps.store.transition(workspace.id, {
      from: ["preserving"],
      to: "failed",
      reason: "checkpoint_failed",
      at: now,
    });
  }
  await failOperation(deps, operation, "checkpoint_failed", now);
}

async function reconcileOperation(
  deps: PersistenceReconcileDeps,
  operation: WorkspaceOperationRow,
  now: Date,
): Promise<void> {
  const context = await loadOperationContext(deps, operation);
  if (operation.kind === "restore") {
    if (!context.workspace) await failOperation(deps, operation, "restore_failed", now);
    return;
  }
  if (!context.checkpoint) {
    await failOperation(deps, operation, "checkpoint_storage_lost", now);
    return;
  }
  if (operation.kind === "verify") {
    await reconcileVerification(deps, operation, context.checkpoint, now);
    return;
  }
  if (operation.kind === "delete") {
    await reconcileDeletion(deps, operation, context.checkpoint, now);
    return;
  }
  if (operation.kind !== "preserve") return;
  if (context.checkpoint.state === "ready" && context.workspace?.state === "preserving") {
    await completePreserve(deps, operation, context.checkpoint, context.workspace, now);
    return;
  }
  await failPreserve(deps, operation, context, now);
}

// Durable operation restart recovery. Physical objects are never adopted or
// deleted merely because metadata is missing; unknown objects are surfaced for
// operator quarantine. Operations either resume from verified metadata or
// fail while retaining their last recoverable storage allocation.
async function reconcilePersistenceState(
  deps: PersistenceReconcileDeps & { storageDriver: WorkspaceStorageDriver },
): Promise<void> {
  const now = deps.now ? deps.now() : new Date();
  const [operations, discoveredStorage, discoveredCheckpoints] = await Promise.all([
    deps.store.listIncompleteOperations(),
    deps.storageDriver.listStorage(),
    deps.storageDriver.listCheckpoints(),
  ]);

  for (const operation of operations) {
    await reconcileOperation(deps, operation, now);
  }

  for (const physical of discoveredStorage) {
    if (!(await deps.store.getStorage(physical.storageId))) {
      deps.log?.(
        `reconcile: unknown storage ${physical.storageId}; quarantined for operator inspection`,
      );
    }
  }
  for (const physical of discoveredCheckpoints) {
    if (!(await deps.store.getCheckpoint(physical.checkpointId))) {
      deps.log?.(
        `reconcile: unknown checkpoint ${physical.checkpointId}; quarantined for operator inspection`,
      );
    }
  }
}

export async function reconcilePersistence(deps: PersistenceReconcileDeps): Promise<void> {
  const storageDriver = deps.storageDriver;
  if (!storageDriver) {
    await measureReconciliation(deps.metrics, "persistence", true, async () => {});
    return;
  }
  await measureReconciliation(deps.metrics, "persistence", false, () =>
    reconcilePersistenceState({ ...deps, storageDriver }),
  );
}
