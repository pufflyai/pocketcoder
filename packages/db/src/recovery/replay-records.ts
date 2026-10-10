import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DatabaseContext } from "../database/context";
import type { JournalEvent } from "../journal/events";

// Applies one journaled access or content change to a restored database. Records are replayed
// in journal order and name exact targets, so repeating the whole journal is safe.
export function createRecordReplay({ db, tables }: DatabaseContext) {
  const { machineKeys, principals, secrets, templates } = tables;
  const { workspaceConversations: conversations, workspaceConversationMessages: messages } = tables;

  async function revoke(ids: string[], at: Date) {
    if (!ids.length) return;
    await db
      .update(machineKeys)
      .set({ revokedAt: at })
      .where(and(inArray(machineKeys.id, ids), isNull(machineKeys.revokedAt)));
  }

  async function deleteConversation(workspaceId: string, at: Date) {
    await db.transaction(async (tx) => {
      await tx.delete(messages).where(eq(messages.workspaceId, workspaceId));
      await tx
        .insert(conversations)
        .values({ workspaceId, status: "deleted", deletedAt: at, updatedAt: at })
        .onConflictDoUpdate({
          target: conversations.workspaceId,
          set: { status: "deleted", expiresAt: null, deletedAt: at, updatedAt: at },
        });
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
      case "conversation_deleted":
        return deleteConversation(event.workspaceId, at);
    }
  };
}
