import { randomUUID } from "node:crypto";
import { ApiError } from "@pstdio/pocketcoder-contracts";
import type { ConversationMessageRow, ConversationTurnCommit } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { requiredRow } from "../../database/required-row";
import { requireContentWritable } from "../persistence/content";
import { buildRecordDocument, type RecordInput } from "./record-document";

const MAX_CONVERSATION_BYTES = 50 * 1024 * 1024;
const MAX_WORKSPACE_BYTES = 50 * 1024 * 1024;
const MAX_CONVERSATION_MESSAGES = 100_000;

export interface RecordWrite extends Omit<RecordInput, "firstSeq"> {
  workspaceId: string;
  recordKey: string;
  createdAt: Date;
}

// Creates the document on its first record and locks it, so records of one conversation
// get consecutive sequence numbers while other conversations write in parallel.
export async function lockDocument(
  context: DatabaseContext,
  tx: Transaction,
  workspaceId: string,
  conversationId: string | null,
  at: Date,
  legacy = false,
) {
  const { conversations, workspaces } = context.tables;
  const [workspace] = await tx
    .select({ principalId: workspaces.principalId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const principalId = requiredRow(workspace).principalId;
  await tx
    .insert(conversations)
    .values({
      id: randomUUID(),
      principalId,
      conversationId,
      workspaceId,
      legacy,
      status: "retained",
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoNothing();
  const identity =
    conversationId === null
      ? and(eq(conversations.workspaceId, workspaceId), isNull(conversations.conversationId))
      : and(eq(conversations.principalId, principalId), eq(conversations.conversationId, conversationId));
  const [document] = await tx.select().from(conversations).where(identity).for("update");
  return requiredRow(document);
}

type LockedDocument = Awaited<ReturnType<typeof lockDocument>>;

// One insert per record. Totals are running values on the document row, never a scan.
export async function insertRecord(
  context: DatabaseContext,
  tx: Transaction,
  document: LockedDocument,
  write: RecordWrite,
) {
  const { conversations, conversationRecords: records } = context.tables;
  const body = buildRecordDocument({ ...write, firstSeq: document.lastSeq + 1 });
  const bytes = Buffer.byteLength(JSON.stringify(body));
  const lastSeq = document.lastSeq + body.messages.length;
  const [record] = await tx
    .insert(records)
    .values({
      conversationRef: document.id,
      recordSeq: document.recordCount + 1,
      recordKey: write.recordKey,
      workspaceId: write.workspaceId,
      firstSeq: document.lastSeq + 1,
      lastSeq,
      status: write.status,
      document: body,
      bytes,
      createdAt: write.createdAt,
    })
    .returning();
  // A new record makes the conversation active again; retention restarts when this workspace ends.
  await tx
    .update(conversations)
    .set({
      workspaceId: write.workspaceId,
      recordCount: document.recordCount + 1,
      messageCount: document.messageCount + body.messages.length,
      bytes: document.bytes + bytes,
      lastSeq,
      expiresAt: null,
      retentionSet: false,
      updatedAt: write.createdAt,
    })
    .where(eq(conversations.id, document.id));
  return requiredRow(record);
}

export function createConversationDocuments(context: DatabaseContext) {
  const {
    db,
    tables: { conversationRecords: records, workspaceConversations },
  } = context;

  async function chargeWorkspace(tx: Transaction, workspaceId: string, bytes: number, at: Date) {
    await tx
      .insert(workspaceConversations)
      .values({ workspaceId, status: "retained", updatedAt: at })
      .onConflictDoNothing({ target: workspaceConversations.workspaceId });
    const [state] = await tx
      .select()
      .from(workspaceConversations)
      .where(eq(workspaceConversations.workspaceId, workspaceId))
      .for("update");
    if (requiredRow(state).status === "deleted")
      throw new ApiError("conversation.deleted", "Conversation history was deleted.");
    if (requiredRow(state).bytes + bytes > MAX_WORKSPACE_BYTES) throw new Error("conversation.quota_exceeded");
    await tx
      .update(workspaceConversations)
      .set({ bytes: sql`${workspaceConversations.bytes} + ${bytes}`, updatedAt: at })
      .where(eq(workspaceConversations.workspaceId, workspaceId));
  }

  async function writeRecord(conversationId: string | null, write: RecordWrite) {
    return db.transaction(async (tx) => {
      await requireContentWritable(tx, context.tables, write.workspaceId);
      const document = await lockDocument(context, tx, write.workspaceId, conversationId, write.createdAt);
      const [existing] = await tx
        .select()
        .from(records)
        .where(and(eq(records.conversationRef, document.id), eq(records.recordKey, write.recordKey)));
      if (existing) return { record: existing, created: false };
      if (document.status !== "retained")
        throw new ApiError("conversation.deleted", "Conversation history was deleted.");
      const bytes = Buffer.byteLength(
        JSON.stringify(buildRecordDocument({ ...write, firstSeq: document.lastSeq + 1 })),
      );
      if (
        document.messageCount + write.messages.length > MAX_CONVERSATION_MESSAGES ||
        document.bytes + bytes > MAX_CONVERSATION_BYTES
      )
        throw new Error("conversation.quota_exceeded");
      await chargeWorkspace(tx, write.workspaceId, bytes, write.createdAt);
      return { record: await insertRecord(context, tx, document, write), created: true };
    });
  }

  return {
    commitConversationTurn(turn: ConversationTurnCommit) {
      return writeRecord(turn.identity.conversation_id, {
        workspaceId: turn.workspaceId,
        recordKey: turn.identity.turn_id,
        request: turn.identity,
        status: turn.status,
        reason: turn.reason,
        messages: turn.messages,
        startedAt: turn.startedAt,
        endedAt: turn.endedAt,
        createdAt: turn.endedAt,
      });
    },
    appendWorkspaceMessage(message: ConversationMessageRow) {
      return writeRecord(null, {
        workspaceId: message.workspaceId,
        recordKey: message.messageId,
        request: null,
        status: "message",
        reason: null,
        messages: [{ ...message, identity: null }],
        startedAt: null,
        endedAt: message.occurredAt,
        createdAt: message.createdAt,
      });
    },
  };
}
