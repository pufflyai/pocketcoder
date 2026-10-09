import {
  deadlinePreservationExpiry,
  type Store,
  type WorkspaceCheckpointRow,
  type WorkspaceRow,
} from "@pstdio/pocketcoder-runtime-core";

export function checkpointTransferExpiry(workspace: WorkspaceRow, deadlineMs: number) {
  const deadline = workspace.deadlineAt.getTime();
  if (!Number.isFinite(deadline) || deadline <= Date.now())
    throw new Error("Checkpoint workspace deadline is invalid.");
  return new Date(Math.min(deadline, Date.now() + deadlineMs));
}

export async function checkpointPreservationExpiry(
  store: Store,
  workspace: WorkspaceRow,
  checkpoint: WorkspaceCheckpointRow,
  operationId: string,
  deadlineMs: number,
) {
  const operation = await store.getOperation(operationId);
  if (
    !operation ||
    operation.workspaceId !== workspace.id ||
    operation.checkpointId !== checkpoint.id ||
    operation.principalId !== workspace.principalId ||
    !["pending", "running"].includes(operation.state)
  )
    throw new Error("Checkpoint preserve operation authority is invalid.");
  const expiresAt =
    deadlinePreservationExpiry(workspace, operation, deadlineMs) ?? checkpointTransferExpiry(workspace, deadlineMs);
  if (expiresAt <= new Date()) throw new Error("Checkpoint preservation lifecycle expired.");
  return expiresAt;
}
