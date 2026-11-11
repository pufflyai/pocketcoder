import { ConversationRequestIdentitySchema } from "@pstdio/pocketcoder-contracts";
import type { ConversationRetention, ConversationTurnCommit } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq, inArray, isNotNull, isNull, lte, or, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import type { DatabaseContext, QueryContext } from "../../database/context";
import { removeRequestContent } from "../sessions/request-content";

const PRUNE_BATCH = 500;

// Removes the records of whole conversations and keeps a tombstone, so a late producer
// write is refused instead of starting a new document. The documents are locked first: a turn
// being committed either lands before the clear or finds the tombstone. `still` is checked
// again on the locked rows.
export async function clearConversations(
  context: DatabaseContext,
  tx: QueryContext,
  ids: string[] | SQLWrapper,
  status: "deleted" | "expired",
  at: Date,
  still?: SQL,
) {
  const { conversations, conversationRecords: records, workspaceConversations, managedSessions } = context.tables;
  // A managed terminal commit holds its session row, then the document. Take them in that order too.
  const owners = await tx
    .select({ principalId: conversations.principalId, conversationId: conversations.conversationId })
    .from(conversations)
    .where(and(inArray(conversations.id, ids), still));
  for (const owner of owners.sort((a, b) => String(a.conversationId).localeCompare(String(b.conversationId))))
    if (owner.conversationId)
      await tx
        .select({ sessionId: managedSessions.sessionId })
        .from(managedSessions)
        .where(
          and(eq(managedSessions.principalId, owner.principalId), eq(managedSessions.sessionId, owner.conversationId)),
        )
        .for("update");
  const locked = await tx
    .select({
      id: conversations.id,
      principalId: conversations.principalId,
      conversationId: conversations.conversationId,
    })
    .from(conversations)
    .where(and(inArray(conversations.id, ids), still))
    .for("update");
  if (!locked.length) return 0;
  const documents = locked.map((row) => row.id);
  for (const document of locked)
    if (document.conversationId) {
      await removeRequestContent(context, tx, document.principalId, document.conversationId);
      // Session events carry final text too; replay from before the deletion reports cursor_expired.
      await tx
        .delete(context.tables.managedObservations)
        .where(
          and(
            eq(context.tables.managedObservations.principalId, document.principalId),
            eq(context.tables.managedObservations.sessionId, document.conversationId),
          ),
        );
    }
  // The workspace quota counts stored records, so it gets their bytes back.
  const charged = await tx
    .select({ workspaceId: records.workspaceId, bytes: sql<number>`sum(${records.bytes})`.mapWith(Number) })
    .from(records)
    .where(inArray(records.conversationRef, documents))
    .groupBy(records.workspaceId);
  for (const row of charged)
    await tx
      .update(workspaceConversations)
      .set({ bytes: sql`greatest(${workspaceConversations.bytes} - ${row.bytes}, 0)` })
      .where(eq(workspaceConversations.workspaceId, row.workspaceId));
  await tx.delete(records).where(inArray(records.conversationRef, documents));
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
    .where(inArray(conversations.id, documents));
  return documents.length;
}

// Every conversation that one workspace wrote to, including its messages without identity.
export function conversationIds(context: DatabaseContext, tx: QueryContext, workspaceId: string) {
  const { conversations, conversationRecords: records } = context.tables;
  return tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        sql`NOT EXISTS (SELECT 1 FROM ${context.tables.managedSessions} s WHERE s.principal_id = ${conversations.principalId} AND s.conversation_id = ${conversations.conversationId})`,
        or(
          eq(conversations.workspaceId, workspaceId),
          inArray(
            conversations.id,
            tx.select({ id: records.conversationRef }).from(records).where(eq(records.workspaceId, workspaceId)),
          ),
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
            isNull(requests.managed),
            isNull(requests.execution),
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
      const due = and(
        eq(conversations.status, "retained"),
        isNotNull(conversations.expiresAt),
        lte(conversations.expiresAt, at),
      );
      const expired = db.select({ id: conversations.id }).from(conversations).where(due).limit(PRUNE_BATCH);
      // A turn committed after the select makes its conversation active again; the lock rechecks it.
      return db.transaction((tx) => clearConversations(context, tx, expired, "expired", at, due));
    },
  };
}
