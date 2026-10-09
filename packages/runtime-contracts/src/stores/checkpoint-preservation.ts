import type { WorkspaceOperationRow } from "./persistence";
import type { WorkspaceRow } from "./workspaces";

export const MAX_CHECKPOINT_PRESERVATION_MS = 60_000;

export function deadlinePreservationExpiry(
  workspace: WorkspaceRow,
  operation: WorkspaceOperationRow,
  budgetMs: number,
) {
  const workloadDeadline = workspace.deadlineAt.getTime();
  const admittedAt = operation.createdAt.getTime();
  if (
    workspace.state !== "preserving" ||
    workspace.reasonCode !== "preserved_by_policy" ||
    operation.kind !== "preserve" ||
    operation.reasonCode !== "preserved_by_policy" ||
    operation.idempotencyKey !== `policy:deadline:${workspace.id}` ||
    workspace.templateSnapshot.spec.persistence.checkpoint.onDeadline !== "preserve" ||
    !Number.isFinite(workloadDeadline) ||
    !Number.isFinite(admittedAt) ||
    admittedAt < workloadDeadline ||
    admittedAt > Date.now()
  )
    return null;
  if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0 || budgetMs > MAX_CHECKPOINT_PRESERVATION_MS)
    throw new Error("Checkpoint preservation deadline budget is invalid.");
  // The server-created operation origin is immutable; preparation and retries cannot renew it.
  return new Date(admittedAt + budgetMs);
}
