import type { ConversationFact, ConversationPart, ExecutionRecord } from "@pstdio/pocketcoder-contracts";
import type { ConversationMessageRow } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq, sql } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { contentWritable } from "../persistence/content";
import { insertRecord, lockDocument } from "./documents";

type RequestRow = DatabaseContext["tables"]["conversationRequests"]["$inferSelect"];
type Message = Omit<ConversationMessageRow, "workspaceId" | "createdAt">;

// Producer history wins. Only a proved terminal execution may fill a gap after recovery.
export async function commitExecutionHistory(
  context: DatabaseContext,
  tx: Transaction,
  row: RequestRow,
  record: ExecutionRecord,
) {
  if (row.managed || !record.finalizedAt || record.phase === "unknown") return;
  const workspaceId = record.acceptance.execution.workspaceId;
  if (!(await contentWritable(tx, context.tables, workspaceId))) return;
  const endedAt = new Date(record.finalizedAt);
  const document = await lockDocument(context, tx, workspaceId, row.conversationId, endedAt);
  if (document.status !== "retained") return;
  const records = context.tables.conversationRecords;
  const [existing] = await tx
    .select({ id: records.id })
    .from(records)
    .where(and(eq(records.conversationRef, document.id), eq(records.recordKey, row.identity.turn_id)));
  if (existing) return;
  const outcome = terminalOutcome(record);
  const messages = fallbackMessages(row, record, outcome.status, outcome.finalResponse);
  const saved = await insertRecord(context, tx, document, {
    workspaceId,
    recordKey: row.identity.turn_id,
    request: row.identity,
    status: outcome.status,
    reason: record.finalizationBasis ?? null,
    messages,
    startedAt: new Date(record.acceptedAt),
    endedAt,
    createdAt: endedAt,
  });
  await tx
    .insert(context.tables.workspaceConversations)
    .values({ workspaceId, status: "retained", updatedAt: endedAt })
    .onConflictDoNothing({ target: context.tables.workspaceConversations.workspaceId });
  await tx
    .update(context.tables.workspaceConversations)
    .set({ bytes: sql`${context.tables.workspaceConversations.bytes} + ${saved.bytes}`, updatedAt: endedAt })
    .where(eq(context.tables.workspaceConversations.workspaceId, workspaceId));
}
function terminalOutcome(record: ExecutionRecord) {
  let status: "completed" | "canceled" | "lost" | "failed" = "failed";
  if (record.phase === "canceled") status = "canceled";
  if (record.phase === "lost") status = "lost";
  const outcome = record.outcome;
  let finalResponse: string | null = null;
  if (outcome && typeof outcome === "object" && !Array.isArray(outcome)) {
    if (
      outcome.status === "completed" ||
      outcome.status === "failed" ||
      outcome.status === "canceled" ||
      outcome.status === "lost"
    )
      status = outcome.status;
    if (typeof outcome.finalResponse === "string") finalResponse = outcome.finalResponse;
  }
  return { status, finalResponse };
}
function fallbackMessages(
  row: RequestRow,
  record: ExecutionRecord,
  status: ReturnType<typeof terminalOutcome>["status"],
  finalResponse: string | null,
) {
  const messages: Message[] = [];
  const message = (role: Message["role"], parts: ConversationPart[], at: string, fact?: ConversationFact) => {
    const messageId = `${row.identity.turn_id}:${messages.length}`;
    messages.push({
      messageId,
      role,
      content: parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join(""),
      parts,
      occurredAt: new Date(at),
      metadata: {},
      identity: {
        ...row.identity,
        event_id: crypto.randomUUID(),
        message_id: messageId,
        sequence: messages.length,
        revision: 1,
        ...(fact ? { fact } : {}),
      },
    });
  };
  const input = record.acceptance.input;
  if (typeof input.message === "string")
    message(
      "user",
      [
        { type: "text", text: input.message },
        ...record.acceptance.inputs.objects.map((file) => ({
          type: "file" as const,
          file_id: file.fileId,
          name: file.name,
          media_type: file.mediaType,
          size_bytes: file.sizeBytes,
        })),
      ],
      record.acceptedAt,
    );
  const endedAt = record.finalizedAt!;
  if (finalResponse !== null)
    message("assistant", [{ type: "text", text: finalResponse }], endedAt, { type: "final_response" });
  if (status === "lost" || status === "failed")
    message(
      "assistant",
      [
        {
          type: "error",
          code: `execution_${status}`,
          message: `Session ${status}. Its producer could not supply retained messages.`,
        },
      ],
      endedAt,
    );
  message("system", [], endedAt, { type: "turn_terminal", outcome: status });
  return messages;
}
