import { canTransition, isTerminal, parseDurationMs } from "@pstdio/pocketcoder-contracts";
import { purgedContentPatch, type TransitionRequest, type WorkspacePatch } from "@pstdio/pocketcoder-runtime-contracts";
import { asc, eq, ne, sql } from "drizzle-orm";
import { type DatabaseContext, notifyChange } from "../../database/context";
import { requiredRow } from "../../database/required-row";
import { appendTransition } from "./events";
import { workspaceFromRow } from "./mapping";
import { CHANGE_PATCH_KEYS } from "./patch";

export function createTransitions(context: DatabaseContext) {
  const {
    db,
    tables: { workspaces, workspaceConversations, workspaceStateHistory },
  } = context;
  return {
    async updateWorkspace(id: string, patch: WorkspacePatch, at: Date) {
      const bumpsChange = Object.keys(patch).some((key) => CHANGE_PATCH_KEYS.has(key));
      await db.transaction(async (tx) => {
        const [current] = await tx.select().from(workspaces).where(eq(workspaces.id, id)).for("update");
        await tx
          .update(workspaces)
          .set({
            ...patch,
            ...(current?.purgeRequestedAt ? purgedContentPatch() : {}),
            updatedAt: at,
            ...(bumpsChange ? { changeSeq: sql`${workspaces.changeSeq}+1` } : {}),
          })
          .where(eq(workspaces.id, id));
      });
      if (bumpsChange) notifyChange(context, id);
    },
    async transition(id: string, req: TransitionRequest) {
      const workspace = await db.transaction(async (tx) => {
        const [current] = await tx.select().from(workspaces).where(eq(workspaces.id, id)).for("update");
        if (!current || !req.from.includes(current.state) || !canTransition(current.state, req.to)) return null;
        if (current.purgeRequestedAt && ["provisioning", "connected", "ready", "preserving", "queued"].includes(req.to))
          return null;
        const terminal = isTerminal(req.to);
        const [row] = await tx
          .update(workspaces)
          .set({
            ...req.patch,
            ...(current.purgeRequestedAt ? purgedContentPatch() : {}),
            state: req.to,
            reasonCode: req.reason,
            updatedAt: req.at,
            changeSeq: sql`${workspaces.changeSeq}+1`,
            ...(terminal ? { terminalAt: req.at, launchInput: null, registrationDigest: null } : {}),
          })
          .where(eq(workspaces.id, id))
          .returning();
        const result = workspaceFromRow(requiredRow(row));
        await appendTransition(context, tx, result, current.state, result.reasonCode, req.at);
        if (terminal) {
          const expiresAt = new Date(
            req.at.getTime() + parseDurationMs(result.templateSnapshot.spec.persistence.conversationRetention),
          );
          await tx
            .insert(workspaceConversations)
            .values({ workspaceId: id, status: "retained", expiresAt, updatedAt: req.at })
            .onConflictDoUpdate({
              target: workspaceConversations.workspaceId,
              set: { expiresAt, updatedAt: req.at },
              setWhere: ne(workspaceConversations.status, "deleted"),
            });
        }
        return result;
      });
      if (workspace) notifyChange(context, id);
      return workspace;
    },
    async listStateHistory(workspaceId: string) {
      return db
        .select()
        .from(workspaceStateHistory)
        .where(eq(workspaceStateHistory.workspaceId, workspaceId))
        .orderBy(asc(workspaceStateHistory.occurredAt));
    },
  };
}
