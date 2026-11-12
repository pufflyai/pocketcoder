import { ApiError, managed } from "@pstdio/pocketcoder-contracts";
import type { ManagedCapacityIdentity, ManagedCapacityRecord } from "@pstdio/pocketcoder-runtime-contracts";
import { eq } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { authorityContext, unavailable } from "../managed/authority-context";
import { sessionWriter } from "../sessions/observations";

export async function placeManagedCapacity(context: DatabaseContext, tx: Transaction, id: ManagedCapacityIdentity) {
  const { tables } = context,
    table = tables.managedCapacity;
  const [principal] = await tx
    .select()
    .from(tables.principals)
    .where(eq(tables.principals.id, id.principalId))
    .for("update");
  if (!principal || principal.disabledAt) throw unavailable();
  const session = await sessionWriter(context).read(tx, id);
  if (session.close || id.generation < 1) throw new ApiError("session.closed", "Invalid placement generation.");
  const { profile } = await authorityContext(context).profile(tx, id.principalId, session.session.profile);
  const placement = managed.managedPlacement(id.principalId, session.session, profile);
  const rows = await tx.select().from(table);
  const known = rows.find((r) => r.workspaceId === id.workspaceId);
  if (known?.record.drainingAt || known?.record.state === "released") throw unavailable();
  const participant = known?.record.sessions.find((s) => s.sessionId === id.sessionId && !s.stoppedAt);
  if (participant) {
    if (participant.generation !== id.generation) throw new ApiError("revision.stale", "Process generation changed.");
    return;
  }
  if (known && (known.record.placementKey !== placement.key || placement.mode !== "shared")) throw unavailable();
  if (
    rows.some(
      (r) =>
        r.record.principalId === id.principalId &&
        r.workspaceId !== id.workspaceId &&
        r.record.state !== "released" &&
        r.record.sessions.some((s) => s.sessionId === id.sessionId && !s.stoppedAt),
    )
  )
    throw new ApiError("operation.conflict", "Previous process capacity is still held.");
  const own = rows.filter(
    (r) =>
      r.record.principalId === id.principalId &&
      r.record.profile === session.session.profile &&
      r.record.owner === session.session.owner &&
      r.record.state !== "released",
  );
  if (
    (!known && own.length >= profile.limits.workspacesPerOwner) ||
    (known && known.record.sessions.filter((s) => !s.stoppedAt).length >= profile.limits.sessionsPerWorkspace)
  )
    throw new ApiError("operation.conflict", "Owner capacity is full.");
  const record: ManagedCapacityRecord = known?.record ?? {
    principalId: id.principalId,
    profile: session.session.profile,
    owner: session.session.owner,
    group: session.session.group,
    templateVersion: profile.templateVersion,
    templateDigest: profile.templateDigest,
    placementKey: placement.key,
    sessions: [],
    state: "reserved",
    launchAttempt: 0,
    submitted: false,
    drainingAt: null,
    lastUsedAt: new Date().toISOString(),
    cleanup: null,
  };
  await tx
    .insert(table)
    .values({
      workspaceId: id.workspaceId,
      record: {
        ...record,
        sessions: [...record.sessions, { sessionId: id.sessionId, generation: id.generation, stoppedAt: null }],
      },
    })
    .onConflictDoUpdate({
      target: table.workspaceId,
      set: {
        record: {
          ...record,
          sessions: [...record.sessions, { sessionId: id.sessionId, generation: id.generation, stoppedAt: null }],
        },
      },
    });
}
