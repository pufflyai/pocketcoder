import { ApiError, managed } from "@pstdio/pocketcoder-contracts";
import type { ManagedCapacityRecord } from "@pstdio/pocketcoder-runtime-contracts";
import { eq } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { authorityContext } from "../managed/authority-context";
import { sessionWriter } from "../sessions/observations";
import { assertRoom, capacityUsage } from "./capacity-ledger";
import { policyOwner } from "./policy-owner";
import { lockScopes } from "./scope-locks";

// Runs before the admission owner locks the workspace or spends a launch attempt.
export async function capacityAdmission(context: DatabaseContext, tx: Transaction, workspaceId: string, now: Date) {
  const { tables } = context;
  const [row] = await tx
    .select()
    .from(tables.managedCapacity)
    .where(eq(tables.managedCapacity.workspaceId, workspaceId));
  if (!row) {
    // A session placement records its capacity right after creating the workspace; launch waits for it.
    const [workspace] = await tx
      .select({ metadata: tables.workspaces.metadata })
      .from(tables.workspaces)
      .where(eq(tables.workspaces.id, workspaceId));
    return !workspace?.metadata[managed.MANAGED_SESSION_METADATA];
  }
  const [principal] = await tx
    .select()
    .from(tables.principals)
    .where(eq(tables.principals.id, row.record.principalId))
    .for("update");
  if (!principal || principal.disabledAt) return false;
  for (const participant of [...row.record.sessions].sort((a, b) => a.sessionId.localeCompare(b.sessionId)))
    await sessionWriter(context).read(tx, { principalId: row.record.principalId, sessionId: participant.sessionId });
  const at = await lockScopes(context, tx, row.record.scopeIds, now);
  try {
    const auth = authorityContext(context);
    const profile = await auth.profile(tx, principal.id, row.record.profileId, row.record.profileRevision);
    await auth.validateScopes(tx, principal.id, profile.profile);
    for (const scopeId of row.record.scopeIds) {
      const policy = await policyOwner(context).latest(tx, scopeId);
      const usage = await capacityUsage(context, tx, policy, at);
      assertRoom(policy.limits.workspaceStarts, usage.workspaceStarts + usage.pendingStarts, 1);
      if (row.record.state === "released") assertRoom(policy.limits.maxActiveWorkspaces, usage.activeWorkspaces, 1);
    }
    return true;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return false;
  }
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
      .set({ record: { ...row.record, state: "reserved", cleanup: null, admittedAttempt: attempt } })
      .where(eq(table.workspaceId, workspaceId));
}

export async function requireCapacityLaunch(
  context: DatabaseContext,
  tx: Transaction,
  record: ManagedCapacityRecord,
  attempt: number,
  at: Date,
) {
  const [principal] = await tx
    .select()
    .from(context.tables.principals)
    .where(eq(context.tables.principals.id, record.principalId));
  if (!principal || principal.disabledAt) throw new ApiError("budget.conflict", "Managed authority is unavailable.");
  const auth = authorityContext(context);
  const profile = await auth.profile(tx, record.principalId, record.profileId, record.profileRevision);
  await auth.validateScopes(tx, record.principalId, profile.profile);
  await lockScopes(context, tx, record.scopeIds, at);
  if (!Number.isSafeInteger(attempt) || attempt < 1 || record.starts.some((start) => start.attempt > attempt))
    throw new ApiError("revision.stale", "Launch attempt changed.");
  for (const scopeId of record.scopeIds) {
    const policy = await policyOwner(context).latest(tx, scopeId);
    const usage = await capacityUsage(context, tx, policy, at);
    const own = record.admittedAttempt === attempt ? 1 : 0;
    assertRoom(policy.limits.workspaceStarts, usage.workspaceStarts + usage.pendingStarts - own, 1);
    if (record.state === "released") assertRoom(policy.limits.maxActiveWorkspaces, usage.activeWorkspaces, 1);
  }
}
