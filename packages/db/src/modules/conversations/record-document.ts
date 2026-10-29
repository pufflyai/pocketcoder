import type {
  ConversationActivity,
  ConversationRecordDocument,
  ConversationRequestIdentity,
} from "@pstdio/pocketcoder-contracts";
import type { ConversationMessageRow } from "@pstdio/pocketcoder-runtime-contracts";

export interface RecordInput {
  request: ConversationRequestIdentity | null;
  status: ConversationRecordDocument["status"];
  reason: string | null;
  firstSeq: number;
  messages: Omit<ConversationMessageRow, "workspaceId" | "createdAt">[];
  startedAt: Date | null;
  endedAt: Date | null;
}

// Facts are kept verbatim on each message; the summaries let readers skip the message list.
function activities(messages: RecordInput["messages"]) {
  const byId = new Map<string, ConversationActivity>();
  for (const message of messages) {
    const fact = message.identity?.fact;
    if (fact?.type === "activity_started")
      byId.set(fact.activity_id, {
        activity_id: fact.activity_id,
        kind: fact.kind,
        label: fact.label,
        action: fact.action ?? null,
        subject: fact.subject ?? null,
        started_at: fact.started_at,
        ended_at: byId.get(fact.activity_id)?.ended_at ?? null,
        outcome: byId.get(fact.activity_id)?.outcome ?? null,
      });
    if (fact?.type === "activity_finished") {
      const started = byId.get(fact.activity_id);
      if (started) byId.set(fact.activity_id, { ...started, ended_at: fact.ended_at, outcome: fact.outcome });
    }
  }
  return [...byId.values()];
}

// ADR 002: the final text comes only from an explicit final-response fact.
function finalResponse(messages: RecordInput["messages"]) {
  return messages.findLast((message) => message.identity?.fact?.type === "final_response")?.content ?? null;
}

export function buildRecordDocument(input: RecordInput): ConversationRecordDocument {
  return {
    schema: "pocketcoder.conversation-record/v1",
    turn_id: input.request?.turn_id ?? null,
    request: input.request,
    status: input.status,
    reason: input.reason,
    messages: input.messages.map((message, index) => ({
      seq: input.firstSeq + index,
      message_id: message.messageId,
      role: message.role,
      content: message.content,
      occurred_at: message.occurredAt.toISOString(),
      metadata: message.metadata,
      identity: message.identity ?? null,
    })),
    activities: activities(input.messages),
    final_response: finalResponse(input.messages),
    started_at: input.startedAt?.toISOString() ?? null,
    ended_at: input.endedAt?.toISOString() ?? null,
  };
}
