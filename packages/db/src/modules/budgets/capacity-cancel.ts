import type { ManagedSessionIdentity } from "@pstdio/pocketcoder-runtime-contracts";
import { eq } from "drizzle-orm";
import type { DatabaseContext } from "../../database/context";
import { lockStorageCapacity } from "../persistence/reservation-capacity";
import { sessionWriter } from "../sessions/observations";

// The same principal/session locks fence workspace insertion. Once released, a delayed
// creator cannot insert this workspace, so never-launched evidence remains true.
export function cancelManagedPlacement(
  context: DatabaseContext,
  id: ManagedSessionIdentity,
  workspaceId: string,
  at: Date,
) {
  const { db, tables } = context;
  return db.transaction(async (tx) => {
    await lockStorageCapacity(context, tx);
    await tx.select().from(tables.principals).where(eq(tables.principals.id, id.principalId)).for("update");
    const writer = sessionWriter(context);
    const session = await writer.read(tx, id);
    const intent = session.placement;
    if (!intent || intent.workspaceId !== workspaceId || session.binding) return false;
    const [capacity] = await tx
      .select()
      .from(tables.managedCapacity)
      .where(eq(tables.managedCapacity.workspaceId, workspaceId))
      .for("update");
    const [workspace] = await tx
      .select({ id: tables.workspaces.id })
      .from(tables.workspaces)
      .where(eq(tables.workspaces.id, workspaceId));
    const record = capacity?.record;
    if (
      workspace ||
      !record ||
      record.principalId !== id.principalId ||
      record.submitted ||
      record.state !== "reserved" ||
      !record.sessions.some((s) => s.sessionId === id.sessionId && s.generation === intent.generation && !s.stoppedAt)
    )
      return false;
    const stoppedAt = at.toISOString();
    const sessions = record.sessions.map((s) => (s.sessionId === id.sessionId ? { ...s, stoppedAt } : s));
    const released = sessions.every((s) => s.stoppedAt);
    await tx
      .update(tables.managedCapacity)
      .set({
        record: {
          ...record,
          sessions,
          state: released ? "released" : record.state,
          cleanup: released
            ? {
                workspaceId,
                generationId: String(record.launchAttempt),
                revision: 1,
                state: "proved",
                basis: "never_launched",
                observedAt: stoppedAt,
                capacityReleasedAt: stoppedAt,
              }
            : record.cleanup,
        },
      })
      .where(eq(tables.managedCapacity.workspaceId, workspaceId));
    await tx
      .update(tables.managedSessions)
      .set({ placement: null, lastGeneration: Math.max(session.lastGeneration, intent.generation) })
      .where(writer.where(id));
    if (!session.close) await writer.update(tx, id, session.session.revision, "suspended", "template_unavailable");
    return true;
  });
}
