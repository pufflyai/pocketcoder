import { ApiError, managed } from "@pstdio/pocketcoder-contracts";
import type { ManagedCapacityRecord } from "@pstdio/pocketcoder-runtime-contracts";
import { eq } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";

export async function capacityAdmission(context: DatabaseContext, tx: Transaction, workspaceId: string, _now: Date) {
  const { tables } = context;
  const [row] = await tx
    .select()
    .from(tables.managedCapacity)
    .where(eq(tables.managedCapacity.workspaceId, workspaceId));
  if (row) return row.record.state !== "released" && !row.record.drainingAt;
  const [workspace] = await tx.select().from(tables.workspaces).where(eq(tables.workspaces.id, workspaceId));
  return !workspace?.metadata[managed.MANAGED_SESSION_METADATA];
}
export async function reserveCapacityAdmission(
  context: DatabaseContext,
  tx: Transaction,
  workspaceId: string,
  attempt: number,
) {
  const table = context.tables.managedCapacity;
  const [row] = await tx.select().from(table).where(eq(table.workspaceId, workspaceId));
  if (row)
    await tx
      .update(table)
      .set({ record: { ...row.record, launchAttempt: attempt, submitted: false } })
      .where(eq(table.workspaceId, workspaceId));
}
export async function requireCapacityLaunch(
  context: DatabaseContext,
  tx: Transaction,
  record: ManagedCapacityRecord,
  attempt: number,
  _at: Date,
) {
  const [principal] = await tx
    .select()
    .from(context.tables.principals)
    .where(eq(context.tables.principals.id, record.principalId));
  if (!principal || principal.disabledAt || record.drainingAt || record.state === "released")
    throw new ApiError("operation.conflict", "Managed placement is unavailable.");
  if (!Number.isSafeInteger(attempt) || attempt < 1 || record.launchAttempt > attempt)
    throw new ApiError("revision.stale", "Launch generation changed.");
}
