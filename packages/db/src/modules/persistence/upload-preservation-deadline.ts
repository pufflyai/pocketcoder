import {
  deadlinePreservationExpiry,
  MAX_CHECKPOINT_PRESERVATION_MS,
  type WorkspaceOperationRow,
  type WorkspaceRow,
} from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq, sql } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";

export async function assertUploadPreservationDeadline(
  context: DatabaseContext,
  tx: Transaction,
  workspace: WorkspaceRow,
  operation: WorkspaceOperationRow,
  expiresAt: Date,
  transferId?: string,
) {
  const workspaces = context.tables.workspaces;
  const operations = context.tables.workspaceOperations;
  const transfers = context.tables.checkpointTransfers;
  const policy = deadlinePreservationExpiry(workspace, operation, MAX_CHECKPOINT_PRESERVATION_MS);
  // Decode-free comparison also fences a native sub-millisecond change after the grant insert.
  const expiry = transferId
    ? sql`coalesce((select ${transfers.expiresAt} from ${transfers} where ${transfers.id} = ${transferId}), ${expiresAt.toISOString()}::timestamptz)`
    : sql`${expiresAt.toISOString()}::timestamptz`;
  const [native] = await tx
    .select({
      valid: policy
        ? sql<boolean>`isfinite(${workspaces.deadlineAt}) AND isfinite(${operations.createdAt}) AND ${operations.createdAt} >= ${workspaces.deadlineAt} AND ${operations.createdAt} <= clock_timestamp() AND isfinite(${expiry}) AND ${expiry} > clock_timestamp() AND ${expiry} <= ${operations.createdAt} + ${MAX_CHECKPOINT_PRESERVATION_MS} * interval '1 millisecond'`
        : sql<boolean>`isfinite(${workspaces.deadlineAt}) AND ${workspaces.deadlineAt} > clock_timestamp() AND isfinite(${expiry}) AND ${expiry} > clock_timestamp() AND ${expiry} <= ${workspaces.deadlineAt}`,
    })
    .from(workspaces)
    .innerJoin(operations, eq(operations.workspaceId, workspaces.id))
    .where(and(eq(workspaces.id, workspace.id), eq(operations.id, operation.id)));
  if (native?.valid !== true) throw new Error("Checkpoint upload deadline authority is invalid.");
}
