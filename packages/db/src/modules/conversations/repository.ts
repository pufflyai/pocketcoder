import type { ConversationRequestIdentity } from "@pstdio/pocketcoder-contracts";
import { and, eq } from "drizzle-orm";
import type { DatabaseContext } from "../../database/context";
import { createConversationDocuments } from "./documents";
import { createConversationReads } from "./reads";
import { createConversationRequests } from "./request-receipts";
import { clearConversations, conversationIds, createConversationRetention } from "./retention";

export function createConversations(context: DatabaseContext) {
  const requestReceipts = createConversationRequests(context);
  const documents = createConversationDocuments(context);
  const {
    db,
    journal,
    tables: { workspaceConversations, conversations },
  } = context;
  return {
    acceptConversationRequest: requestReceipts.acceptConversationRequest,
    isAcceptedTurn: (workspaceId: string, identity: ConversationRequestIdentity) =>
      requestReceipts.isAccepted(workspaceId, identity),
    ...documents,
    ...createConversationReads(context),
    ...createConversationRetention(context, documents.commitConversationTurn),
    async getConversationState(workspaceId: string) {
      const [row] = await db
        .select()
        .from(workspaceConversations)
        .where(eq(workspaceConversations.workspaceId, workspaceId));
      return row ?? null;
    },
    // The journal entry is written first, so a restore replays the deletion.
    async deleteConversation(workspaceId: string, at: Date) {
      journal?.append({ kind: "conversation_deleted", workspaceId, at: at.toISOString() });
      await db.transaction(async (tx) => {
        await clearConversations(context, tx, conversationIds(context, tx, workspaceId), "deleted", at);
        await tx
          .insert(workspaceConversations)
          .values({ workspaceId, status: "deleted", deletedAt: at, updatedAt: at })
          .onConflictDoUpdate({
            target: workspaceConversations.workspaceId,
            set: { status: "deleted", expiresAt: null, deletedAt: at, updatedAt: at },
          });
      });
    },
    async deleteConversationById(principalId: string, conversationId: string, at: Date) {
      const [row] = await db
        .select({ id: conversations.id, workspaceId: conversations.workspaceId })
        .from(conversations)
        .where(and(eq(conversations.principalId, principalId), eq(conversations.conversationId, conversationId)));
      if (!row) return false;
      journal?.append({
        kind: "conversation_deleted",
        workspaceId: row.workspaceId,
        principalId,
        conversationId,
        at: at.toISOString(),
      });
      await db.transaction((tx) => clearConversations(context, tx, [row.id], "deleted", at));
      return true;
    },
  };
}
