import type { WorkspaceCheckpointRow, WorkspaceOperationRow } from "@pstdio/pocketcoder-runtime-core";
import type { PersistenceContext } from "./persistence-base";
import type { PersistencePreserveRunner } from "./persistence-preserve-runner";
import { retainUnpublishedSource } from "./preserve-source-lifecycle";

async function recoverPreserve(
  context: PersistenceContext,
  runner: PersistencePreserveRunner,
  operation: WorkspaceOperationRow,
  checkpoint: WorkspaceCheckpointRow,
) {
  const { store } = context.deps;
  const transfers = await store.checkpointTransfers.listUnsettled();
  if (transfers.some((row) => row.operationId === operation.id && row.state !== "complete")) return;
  if (checkpoint.state === "ready" && operation.workspaceId) {
    await store.updateOperation(operation.id, { state: "pending" }, context.now());
    await runner.runPreserve(operation.workspaceId, checkpoint.id, operation.id);
    return;
  }
  const workspace = operation.workspaceId ? await store.getWorkspace(operation.workspaceId) : null;
  const storage = workspace ? await store.getWorkspaceStorage(workspace.id) : null;
  if (workspace && storage) await retainUnpublishedSource(context, workspace, storage, "checkpoint_failed");
  await store.updateCheckpoint(checkpoint.id, { state: "failed", reasonCode: "checkpoint_failed" }, context.now());
  await context.failOperation(operation.id, "checkpoint_failed");
}

async function recoverVerification(
  context: PersistenceContext,
  operation: WorkspaceOperationRow,
  checkpoint: WorkspaceCheckpointRow,
) {
  const { store, checkpointTransfers } = context.deps;
  try {
    if (checkpoint.state !== "ready") throw new Error("Checkpoint is unavailable.");
    await checkpointTransfers?.verify(checkpoint);
    await store.updateOperation(operation.id, { state: "succeeded", completedAt: context.now() }, context.now());
  } catch {
    await store.updateCheckpoint(checkpoint.id, { state: "failed", reasonCode: "checkpoint_corrupt" }, context.now());
    await context.failOperation(operation.id, "checkpoint_corrupt");
  }
}

export function createPersistenceTransferRecovery(context: PersistenceContext, runner: PersistencePreserveRunner) {
  return async (operation: WorkspaceOperationRow) => {
    const { store, checkpointTransfers } = context.deps;
    if (!checkpointTransfers || !operation.checkpointId) return false;
    if (operation.workspaceId && runner.owns(operation.workspaceId)) return true;
    const checkpoint = await store.getCheckpoint(operation.checkpointId);
    if (checkpoint?.providerKind !== "controller-archive") return false;
    switch (operation.kind) {
      case "preserve":
        // Generic reconciliation distinguishes admission from pending credential cleanup.
        if (operation.state === "pending" && checkpoint.state === "creating") return false;
        await recoverPreserve(context, runner, operation, checkpoint);
        return true;
      case "verify":
        await recoverVerification(context, operation, checkpoint);
        return true;
      case "delete":
        await checkpointTransfers.delete(checkpoint);
        await store.updateCheckpoint(checkpoint.id, { state: "deleted", deletedAt: context.now() }, context.now());
        await store.updateOperation(operation.id, { state: "succeeded", completedAt: context.now() }, context.now());
        return true;
      default:
        return false;
    }
  };
}
