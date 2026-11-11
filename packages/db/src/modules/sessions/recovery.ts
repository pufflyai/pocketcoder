import { ApiError, type managed } from "@pstdio/pocketcoder-contracts";
import type {
  ManagedRecoveryCandidate,
  ManagedRecoveryStore,
  ManagedSessionIdentity,
} from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq, gt, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { DatabaseContext } from "../../database/context";
import { sessionWriter } from "./observations";
import { ownedWorkspaces } from "./session-workspaces";
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
          or(
            and(
              ne(sql`${sessions.session}->>'state'`, "closed"),
              or(
                sql`${sessions.binding} IS NOT NULL`,
                gt(sessions.queueCount, 0),
                sql`${sessions.resumeRequestedAt} IS NOT NULL`,
              ),
            ),
            // A close stays a candidate until its compute has stopped.
            sql`${sessions.close} IS NOT NULL AND ${sessions.close}->>'completedAt' IS NULL`,
          ),
        );
      const profiles = await db.select().from(tables.managedProfiles);
      const requests = tables.conversationRequests;
      const open = await db
        .select({ principalId: requests.principalId, sessionId: requests.conversationId })
        .from(requests)
        .where(sql`${requests.managed} IS NOT NULL AND ${requests.managed}->'request'->>'state' <> 'terminal'`);
      const candidates: ManagedRecoveryCandidate[] = [];
      for (const row of rows) {
        const id = { principalId: row.principalId, sessionId: row.sessionId };
        candidates.push({
          closing: row.close !== null,
          ownedWorkspaceIds: row.close ? await ownedWorkspaces(context, db, id, row.binding) : [],
          openRequests: open.filter((r) => r.principalId === row.principalId && r.sessionId === row.sessionId).length,
          templateDigest:
            profiles.find((p) => p.profileId === row.session.profileId && p.revision === row.session.profileRevision)
              ?.profile.templateDigest ?? "",
          id,
          session: row.session,
          binding: row.binding,
          bindingRevision: row.bindingRevision,
          lastGeneration: row.lastGeneration,
          queueCount: row.queueCount,
          placement: row.placement,
          resumeRequested: row.resumeRequestedAt !== null,
        });
      }
      return candidates;
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
    // A placement whose workspace ended before it was ready consumes its generation, so the next
    // attempt gets a new idempotency key instead of replaying the ended workspace. Resume tries again.
    async failPlacement(id, workspaceId) {
      await db.transaction(async (tx) => {
        const row = await writer.read(tx, id);
        if (row.placement?.workspaceId !== workspaceId) return;
        await tx
          .update(sessions)
          .set({
            placement: null,
            resumeRequestedAt: null,
            lastGeneration: Math.max(row.lastGeneration, row.placement.generation),
          })
          .where(writer.where(id));
        if (row.session.state !== "closed" && row.session.state !== "failed")
          await writer.update(tx, id, row.session.revision, "failed", "placement_failed");
      });
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
