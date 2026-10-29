import type { WorkspaceConversationMessage } from "@pstdio/pocketcoder-runtime-contracts";
import { and, asc, eq, gt, gte, inArray, isNull, or, sql } from "drizzle-orm";
import type { DatabaseContext } from "../../database/context";

// Cursor positions over one workspace's records: record id, then the message index inside it.
const MESSAGES_PER_RECORD = 1_000_000;

export function createConversationReads(context: DatabaseContext) {
  const {
    db,
    schema,
    tables: { conversations, conversationRecords: records },
  } = context;

  return {
    async readWorkspaceConversation(workspaceId: string, afterPosition: number, limit: number) {
      const afterRecord = Math.floor(afterPosition / MESSAGES_PER_RECORD);
      const rows = await db
        .select({ id: records.id, document: records.document })
        .from(records)
        .where(and(eq(records.workspaceId, workspaceId), gte(records.id, afterRecord)))
        .orderBy(asc(records.id))
        // Every record holds at least one message, so this always fills the page.
        .limit(limit + 2);
      const messages: WorkspaceConversationMessage[] = [];
      for (const row of rows)
        for (const [index, message] of row.document.messages.entries()) {
          const position = row.id * MESSAGES_PER_RECORD + index + 1;
          if (position > afterPosition) messages.push({ position, message });
        }
      return messages.slice(0, limit);
    },

    // The workspace's own messages without identity, plus every conversation that it or the
    // workspaces it was restored from wrote to.
    async listConversations(workspaceId: string) {
      const lineage = sql`(WITH RECURSIVE lineage(id) AS (
          SELECT ${workspaceId}::uuid
          UNION SELECT w.origin_workspace_id FROM "${sql.raw(schema)}"."workspaces" w
            JOIN lineage ON w.id = lineage.id WHERE w.origin_workspace_id IS NOT NULL
        ) SELECT id FROM lineage)`;
      const written = db
        .selectDistinct({ id: records.conversationRef })
        .from(records)
        .where(inArray(records.workspaceId, lineage));
      return db
        .select()
        .from(conversations)
        .where(
          or(
            inArray(conversations.id, written),
            and(eq(conversations.workspaceId, workspaceId), isNull(conversations.conversationId)),
          ),
        )
        .orderBy(asc(conversations.createdAt));
    },

    async getConversation(principalId: string, conversationId: string) {
      const [row] = await db
        .select()
        .from(conversations)
        .where(and(eq(conversations.principalId, principalId), eq(conversations.conversationId, conversationId)));
      return row ?? null;
    },

    async readConversationMessages(conversationRef: string, afterSeq: number, limit: number) {
      const rows = await db
        .select({ document: records.document })
        .from(records)
        .where(and(eq(records.conversationRef, conversationRef), gt(records.lastSeq, afterSeq)))
        .orderBy(asc(records.recordSeq))
        .limit(limit);
      return rows
        .flatMap((row) => row.document.messages)
        .filter((message) => message.seq > afterSeq)
        .slice(0, limit);
    },

    readConversationRecords(conversationRef: string) {
      return db
        .select()
        .from(records)
        .where(eq(records.conversationRef, conversationRef))
        .orderBy(asc(records.recordSeq));
    },
  };
}
