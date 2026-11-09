import { ApiError, type managed } from "@pstdio/pocketcoder-contracts";
import type {
  ManagedRecoveryCandidate,
  ManagedRecoveryStore,
  ManagedSessionIdentity,
} from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq, gt, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { DatabaseContext } from "../../database/context";
import { sessionWriter } from "./observations";
import { workAuthority } from "./work-authority";

// Durable placement and resume intents. The server placement owner reads these on every tick,
// so a controller restart continues from the recorded workspace instead of creating another.
export function createManagedRecovery(context: DatabaseContext): ManagedRecoveryStore {
  const { db, tables } = context;
  const sessions = tables.managedSessions;
  const writer = sessionWriter(context);
  const authorize = workAuthority(context);
  const transition = (id: ManagedSessionIdentity, state: managed.Session["state"], reason: string | null) =>
    db.transaction(async (tx) => {
      const row = await writer.read(tx, id);
      if (row.session.state === state || row.session.state === "closed") return row.session;
      return writer.update(tx, id, row.session.revision, state, reason);
    });
  return {
    async candidates() {
      const rows = await db
        .select()
        .from(sessions)
        .where(
          and(
            ne(sql`${sessions.session}->>'state'`, "closed"),
            or(
              sql`${sessions.binding} IS NOT NULL`,
              gt(sessions.queueCount, 0),
              sql`${sessions.resumeRequestedAt} IS NOT NULL`,
            ),
          ),
        );
      const profiles = await db.select().from(tables.managedProfiles);
      return rows.map(
        (row): ManagedRecoveryCandidate => ({
          templateDigest:
            profiles.find((p) => p.profileId === row.session.profileId && p.revision === row.session.profileRevision)
              ?.profile.templateDigest ?? "",
          id: { principalId: row.principalId, sessionId: row.sessionId },
          session: row.session,
          binding: row.binding,
          bindingRevision: row.bindingRevision,
          lastGeneration: row.lastGeneration,
          queueCount: row.queueCount,
          placement: row.placement,
          resumeRequested: row.resumeRequestedAt !== null,
        }),
      );
    },
    // Resume records a desire for compute; it never names or reuses a physical workspace.
    async resume(keyId, sessionId, at) {
      return db.transaction(async (tx) => {
        const { id, row } = await authorize(tx, keyId, sessionId, "sessions:write");
        if (!row.resumeRequestedAt) await tx.update(sessions).set({ resumeRequestedAt: at }).where(writer.where(id));
        return row.session;
      });
    },
    async recordPlacement(id, intent) {
      return db.transaction(async (tx) => {
        const row = await writer.read(tx, id);
        if (row.session.state === "closed") throw new ApiError("session.closed", "Session is closed.");
        if (row.placement) return row.placement;
        if (row.binding || intent.generation !== row.lastGeneration + 1)
          throw new ApiError("revision.stale", "Placement generation changed.");
        await tx.update(sessions).set({ placement: intent }).where(writer.where(id));
        return intent;
      });
    },
    async clearPlacement(id, workspaceId) {
      await db
        .update(sessions)
        .set({ placement: null })
        .where(and(writer.where(id), sql`${sessions.placement}->>'workspaceId' = ${workspaceId}`));
    },
    async placed(id, workspaceId) {
      await db
        .update(sessions)
        .set({ placement: null, resumeRequestedAt: null })
        .where(and(writer.where(id), sql`${sessions.placement}->>'workspaceId' = ${workspaceId}`));
    },
    transition,
  };
}
