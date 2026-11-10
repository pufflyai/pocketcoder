import { ApiError, managed } from "@pstdio/pocketcoder-contracts";
import type { ManagedCapacityRecord } from "@pstdio/pocketcoder-runtime-contracts";
import { eq } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { authorityContext, unavailable } from "../managed/authority-context";
import { sessionWriter } from "../sessions/observations";
import { assertRoom, capacityUsage } from "./capacity-ledger";
import { policyOwner } from "./policy-owner";
import { lockScopes } from "./scope-locks";

function knownParticipant(
  record: ManagedCapacityRecord | undefined,
  id: import("@pstdio/pocketcoder-runtime-contracts").ManagedCapacityIdentity,
  placementKey: string,
) {
  if (!record) return false;
  if (record.placementKey !== placementKey || record.state === "released")
    throw new ApiError("operation.conflict", "Placement authority changed.");
  const participant = record.sessions.find((session) => session.sessionId === id.sessionId);
  if (!participant) return false;
  if (participant.generation !== id.generation || participant.stoppedAt)
    throw new ApiError("revision.stale", "Process generation changed.");
  return true;
}

export async function placeManagedCapacity(
  context: DatabaseContext,
  tx: Transaction,
  id: import("@pstdio/pocketcoder-runtime-contracts").ManagedCapacityIdentity,
) {
  const { tables } = context;
  const table = tables.managedCapacity;
  const auth = authorityContext(context);
  const policies = policyOwner(context);
  const write = async (tx: Transaction, workspaceId: string, record: ManagedCapacityRecord) => {
    await tx
      .insert(table)
      .values({ workspaceId, record })
      .onConflictDoUpdate({ target: table.workspaceId, set: { record } });
  };
  const [principal] = await tx
    .select()
    .from(tables.principals)
    .where(eq(tables.principals.id, id.principalId))
    .for("update");
  if (!principal || principal.disabledAt) throw unavailable();
  const session = await sessionWriter(context).read(tx, id);
  if (session.session.state === "closed" || !Number.isSafeInteger(id.generation) || id.generation < 1)
    throw new ApiError("session.closed", "Invalid placement generation.");
  const profile = await auth.profile(tx, id.principalId, session.session.profileId, session.session.profileRevision);
  await auth.validateScopes(tx, id.principalId, profile.profile);
  const at = await lockScopes(context, tx, profile.profile.budgetScopeIds, new Date());
  const [workspace] = await tx
    .select()
    .from(tables.workspaces)
    .where(eq(tables.workspaces.id, id.workspaceId))
    .for("update");
  if (
    !workspace ||
    workspace.principalId !== id.principalId ||
    workspace.templateDigest !== profile.profile.templateDigest ||
    workspace.terminalAt ||
    workspace.purgeRequestedAt
  )
    throw unavailable();
  const rows = await tx.select().from(table);
  const known = rows.find((row) => row.workspaceId === id.workspaceId);
  const placement = managed.managedPlacement(id.principalId, id.sessionId, profile.profile);
  if (knownParticipant(known?.record, id, placement.key)) return;
  if (
    rows.some(
      (row) =>
        row.workspaceId !== id.workspaceId &&
        row.record.state !== "released" &&
        row.record.sessions.some((s) => s.sessionId === id.sessionId && !s.stoppedAt),
    )
  )
    throw new ApiError("operation.conflict", "Previous process capacity is still held.");
  for (const scopeId of profile.profile.budgetScopeIds) {
    const policy = await policies.latest(tx, scopeId);
    const usage = await capacityUsage(context, tx, policy, at);
    if (!known) assertRoom(policy.limits.maxActiveWorkspaces, usage.activeWorkspaces, 1);
    assertRoom(
      policy.limits.maxChatProcessesPerWorkspace,
      known?.record.sessions.filter((s) => !s.stoppedAt).length ?? 0,
      1,
    );
  }
  if (known && (placement.mode !== "shared" || profile.businessSlots.length)) throw unavailable();
  const record: ManagedCapacityRecord = known?.record ?? {
    principalId: id.principalId,
    profileId: profile.profile.profileId,
    profileRevision: profile.profile.revision,
    scopeIds: profile.profile.budgetScopeIds,
    placementKey: placement.key,
    sessions: [],
    state: "reserved",
    starts: [],
    cleanup: null,
  };
  await write(tx, id.workspaceId, {
    ...record,
    sessions: [...record.sessions, { sessionId: id.sessionId, generation: id.generation, stoppedAt: null }],
  });
}
