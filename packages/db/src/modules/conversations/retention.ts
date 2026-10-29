import { ConversationRequestIdentitySchema } from "@pstdio/pocketcoder-contracts";
import type { ConversationRetention, ConversationTurnCommit } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq, inArray, isNotNull, lte, or, type SQLWrapper, sql } from "drizzle-orm";
import type { DatabaseContext, QueryContext } from "../../database/context";

const PRUNE_BATCH = 500;

// Removes the records of whole conversations and keeps a tombstone, so a late producer
// write is refused instead of starting a new document.
export async function clearConversations(
  context: DatabaseContext,
  tx: QueryContext,
  ids: string[] | SQLWrapper,
  status: "deleted" | "expired",
  at: Date,
) {
  const { conversations, conversationRecords: records } = context.tables;
  await tx.delete(records).where(inArray(records.conversationRef, ids));
  await tx
    .update(conversations)
    .set({
      status,
      recordCount: 0,
      messageCount: 0,
      bytes: 0,
      expiresAt: null,
      deletedAt: status === "deleted" ? at : null,
      updatedAt: at,
    })
    .where(inArray(conversations.id, ids));
}

// Every conversation that one workspace wrote to, including its messages without identity.
export function conversationIds(context: DatabaseContext, tx: QueryContext, workspaceId: string) {
  const { conversations, conversationRecords: records } = context.tables;
  return tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      or(
        eq(conversations.workspaceId, workspaceId),
        inArray(
          conversations.id,
          tx.select({ id: records.conversationRef }).from(records).where(eq(records.workspaceId, workspaceId)),
        ),
      ),
    );
}

export function createConversationRetention(
  context: DatabaseContext,
  commit: (turn: ConversationTurnCommit) => Promise<unknown>,
) {
  const {
    db,
    tables: { conversations, conversationRequests: requests, conversationRecords: records, workspaces },
  } = context;

  return {
    // Turns are written at their end. A receipt without a record after a restart is a turn
    // whose live messages were lost, so history shows it as interrupted instead of a gap.
    // Requests still waiting for dispatch are left alone: dispatch resumes them.
    async recordInterruptedTurns(at: Date) {
      const open = await db
        .select({ workspaceId: requests.workspaceId, identity: requests.identity, acceptedAt: requests.acceptedAt })
        .from(requests)
        .where(
          and(
            isNotNull(requests.workspaceId),
            sql`coalesce(${requests.execution}->>'phase', '') <> 'accepted'`,
            sql`NOT EXISTS (SELECT 1 FROM ${conversations} c JOIN ${records} r ON r.conversation_ref = c.id
              WHERE c.principal_id = ${requests.principalId} AND c.conversation_id = ${requests.conversationId}
              AND r.record_key = ${requests.identity}->>'turn_id')`,
          ),
        );
      let recorded = 0;
      for (const row of open) {
        const identity = ConversationRequestIdentitySchema.parse(row.identity);
        try {
          await commit({
            workspaceId: row.workspaceId as string,
            identity,
            status: "interrupted",
            reason: "controller_restarted",
            messages: [],
            startedAt: row.acceptedAt,
            endedAt: at,
          });
          recorded += 1;
        } catch {
          // A deleted conversation or purged workspace keeps no history to complete.
        }
      }
      return recorded;
    },

    async pruneExpiredConversations(at: Date, retention: ConversationRetention) {
      // Retention starts when the last workspace that wrote to a conversation ends.
      const ended = await db
        .select({ id: conversations.id, terminalAt: workspaces.terminalAt, snapshot: workspaces.templateSnapshot })
        .from(conversations)
        .innerJoin(workspaces, eq(workspaces.id, conversations.workspaceId))
        .where(
          and(
            eq(conversations.status, "retained"),
            eq(conversations.retentionSet, false),
            isNotNull(workspaces.terminalAt),
          ),
        )
        .limit(PRUNE_BATCH);
      for (const row of ended) {
        const keep = retention({ conversationRetention: row.snapshot.spec.persistence.conversationRetention });
        const expiresAt = keep === null ? null : new Date((row.terminalAt as Date).getTime() + keep);
        await db
          .update(conversations)
          .set({ expiresAt, retentionSet: true })
          .where(and(eq(conversations.id, row.id), eq(conversations.retentionSet, false)));
      }
      const expired = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.status, "retained"),
            isNotNull(conversations.expiresAt),
            lte(conversations.expiresAt, at),
          ),
        )
        .limit(PRUNE_BATCH);
      if (!expired.length) return 0;
      await db.transaction((tx) =>
        clearConversations(
          context,
          tx,
          expired.map((row) => row.id),
          "expired",
          at,
        ),
      );
      return expired.length;
    },
  };
}
