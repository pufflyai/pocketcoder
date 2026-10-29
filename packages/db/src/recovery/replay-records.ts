import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../database/context";
import type { JournalEvent } from "../journal/events";
import { clearConversations, conversationIds } from "../modules/conversations/retention";

// Applies one journaled access or content change to a restored database. Records are replayed
// in journal order and name exact targets, so repeating the whole journal is safe.
export function createRecordReplay(context: DatabaseContext) {
  const { db, tables } = context;
  const { machineKeys, principals, secrets, templates } = tables;
  const { workspaceConversations, conversations } = tables;

  async function revoke(ids: string[], at: Date) {
    if (!ids.length) return;
    await db
      .update(machineKeys)
      .set({ revokedAt: at })
      .where(and(inArray(machineKeys.id, ids), isNull(machineKeys.revokedAt)));
  }

  async function deleteConversation(event: Extract<JournalEvent, { kind: "conversation_deleted" }>, at: Date) {
    await db.transaction(async (tx) => {
      if (event.principalId && event.conversationId) {
        const one = tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(
              eq(conversations.principalId, event.principalId),
              eq(conversations.conversationId, event.conversationId),
            ),
          );
        return clearConversations(context, tx, one, "deleted", at);
      }
      await removeHistory(tx, event.workspaceId, at);
    });
  }

  async function removeHistory(tx: Transaction, workspaceId: string, at: Date) {
    await clearConversations(context, tx, conversationIds(context, tx, workspaceId), "deleted", at);
    await tx
      .insert(workspaceConversations)
      .values({ workspaceId, status: "deleted", deletedAt: at, updatedAt: at })
      .onConflictDoUpdate({
        target: workspaceConversations.workspaceId,
        set: { status: "deleted", expiresAt: null, deletedAt: at, updatedAt: at },
      });
  }

  // The purge itself removed provider data; a restored database only needs its rows cleared again.
  async function purgeWorkspace(workspaceId: string, at: Date) {
    await db.transaction(async (tx) => {
      await removeHistory(tx, workspaceId, at);
      for (const table of [
        tables.workspaceLogs,
        tables.workspaceOutputs,
        tables.workspaceNetworkEvents,
        tables.eventOutbox,
      ])
        await tx.delete(table).where(eq(table.workspaceId, workspaceId));
    });
  }

  return async (event: JournalEvent) => {
    const at = new Date(event.at);
    switch (event.kind) {
      case "key_revoked":
        return revoke([event.keyId], at);
      case "keys_revoked":
        return revoke(event.keyIds, at);
      case "principal_disabled":
        await db
          .update(principals)
          .set({ disabledAt: at })
          .where(and(eq(principals.id, event.principalId), isNull(principals.disabledAt)));
        return revoke(event.keyIds, at);
      case "principal_enabled":
        await db.update(principals).set({ disabledAt: null }).where(eq(principals.id, event.principalId));
        return;
      case "principal_access":
        await db
          .update(principals)
          .set({ scopes: event.scopes, templateNames: event.templateNames })
          .where(eq(principals.id, event.principalId));
        return;
      // Only the version that was retired or replaced; a later value stays active.
      case "secret_retired":
        await db
          .update(secrets)
          .set({ retiredAt: at })
          .where(and(eq(secrets.name, event.name), eq(secrets.versionId, event.versionId), isNull(secrets.retiredAt)));
        return;
      case "template_retired":
        await db
          .update(templates)
          .set({ status: "retired", retiredAt: sql`coalesce(${templates.retiredAt}, ${at})` })
          .where(and(eq(templates.name, event.name), eq(templates.version, event.version)));
        return;
      case "workspace_purged":
        return purgeWorkspace(event.workspaceId, at);
      case "checkpoint_deleted":
        await db
          .update(tables.workspaceCheckpoints)
          .set({ state: "deleted", deletedAt: sql`coalesce(${tables.workspaceCheckpoints.deletedAt}, ${at})` })
          .where(eq(tables.workspaceCheckpoints.id, event.checkpointId));
        return;
      case "conversation_deleted":
        return deleteConversation(event, at);
    }
  };
}
