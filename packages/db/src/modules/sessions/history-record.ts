import { randomUUID } from "node:crypto";
import type { ConversationFact, ConversationMessageIdentity } from "@pstdio/pocketcoder-contracts";
import type { ConversationMessageRow, ManagedRequestRecord } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq, sql } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { insertRecord, lockDocument } from "../conversations/documents";

type RequestRow = DatabaseContext["tables"]["conversationRequests"]["$inferSelect"];
type Message = Omit<ConversationMessageRow, "workspaceId" | "createdAt">;

// Producer reason codes use a narrower alphabet than public request reasons.
const producerCode = (reason: string | null) => {
  const code = reason?.replace(/[^a-z0-9_]/g, "_");
  return code && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : undefined;
};

// The terminal request, its canonical history record and its event commit in one transaction,
// before the producer is acknowledged. A record the producer already committed wins: it holds
// the richer live messages. Requests that never reached compute have no turn to record.
export async function commitManagedHistory(
  context: DatabaseContext,
  tx: Transaction,
  row: RequestRow,
  next: ManagedRequestRecord,
) {
  const { request } = next;
  if (request.state !== "terminal") return;
  const workspaceId = next.physicalExecution?.workspaceId ?? next.attempts?.at(-1)?.execution.workspaceId;
  if (!workspaceId) return;
  const endedAt = new Date(request.endedAt ?? new Date().toISOString());
  const document = await lockDocument(context, tx, workspaceId, row.conversationId, endedAt);
  if (document.status !== "retained") return;
  const records = context.tables.conversationRecords;
  const [existing] = await tx
    .select({ id: records.id })
    .from(records)
    .where(and(eq(records.conversationRef, document.id), eq(records.recordKey, row.identity.turn_id)));
  if (existing) return;
  const messages: Message[] = [];
  const message = (role: Message["role"], content: string, occurredAt: string, fact?: ConversationFact) => {
    const messageId = `${row.identity.turn_id}:${messages.length}`;
    const identity: ConversationMessageIdentity = {
      ...row.identity,
      event_id: randomUUID(),
      message_id: messageId,
      sequence: messages.length,
      revision: 1,
      ...(fact ? { fact } : {}),
    };
    messages.push({ messageId, role, content, occurredAt: new Date(occurredAt), metadata: {}, identity });
  };
  if (next.input) message("user", next.input.message, request.acceptedAt);
  if (request.finalResponse !== null)
    message("assistant", request.finalResponse, endedAt.toISOString(), { type: "final_response" });
  const reason = producerCode(request.reasonCode);
  message("system", "", endedAt.toISOString(), {
    type: "turn_terminal",
    outcome: request.outcome,
    ...(reason ? { reason } : {}),
  });
  const record = await insertRecord(context, tx, document, {
    workspaceId,
    recordKey: row.identity.turn_id,
    request: row.identity,
    status: request.outcome,
    reason: request.reasonCode,
    messages,
    startedAt: request.startedAt ? new Date(request.startedAt) : null,
    endedAt,
    createdAt: endedAt,
  });
  // Charged like any record so a later deletion refunds exactly these bytes. The terminal truth is
  // never refused for quota: the request is already over.
  await tx
    .insert(context.tables.workspaceConversations)
    .values({ workspaceId, status: "retained", updatedAt: endedAt })
    .onConflictDoNothing({ target: context.tables.workspaceConversations.workspaceId });
  await tx
    .update(context.tables.workspaceConversations)
    .set({ bytes: sql`${context.tables.workspaceConversations.bytes} + ${record.bytes}`, updatedAt: endedAt })
    .where(eq(context.tables.workspaceConversations.workspaceId, workspaceId));
}
