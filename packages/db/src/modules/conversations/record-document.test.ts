import { expect, test } from "bun:test";
import type { ConversationFact, ConversationRequestIdentity } from "@pstdio/pocketcoder-contracts";
import { buildRecordDocument } from "./record-document";

const request: ConversationRequestIdentity = {
  schema: "pocketcoder.conversation/v2",
  authority: "external",
  conversation_id: "10000000-0000-4000-8000-000000000001",
  request_id: "10000000-0000-4000-8000-000000000002",
  turn_id: "10000000-0000-4000-8000-000000000003",
  request_fingerprint: "a".repeat(64),
};
const at = new Date("2026-10-29T10:00:00Z");

function message(event: number, sequence: number, content: string, fact?: ConversationFact) {
  return {
    messageId: `m-${event}`,
    role: "assistant" as const,
    content,
    occurredAt: at,
    metadata: {},
    identity: {
      ...request,
      event_id: `10000000-0000-4000-8000-00000000010${event}`,
      message_id: `m-${event}`,
      sequence,
      revision: 1,
      ...(fact ? { fact } : {}),
    },
  };
}

test("a turn record numbers its messages and summarises activities and the final response", () => {
  const activity = "10000000-0000-4000-8000-000000000200";
  const document = buildRecordDocument({
    request,
    status: "completed",
    reason: null,
    firstSeq: 7,
    startedAt: at,
    endedAt: at,
    messages: [
      message(1, 0, "Reading", {
        type: "activity_started",
        activity_id: activity,
        kind: "tool",
        label: "Read files",
        started_at: at.toISOString(),
        action: "read_file",
      }),
      message(2, 1, "", { type: "activity_finished", activity_id: activity, ended_at: null, outcome: "completed" }),
      message(3, 2, "Done.", { type: "final_response" }),
      message(4, 3, "", { type: "turn_terminal", outcome: "completed", reason: "finished" }),
    ],
  });
  expect(document.messages.map((row) => row.seq)).toEqual([7, 8, 9, 10]);
  expect(document.turn_id).toBe(request.turn_id);
  expect(document.final_response).toBe("Done.");
  expect(document.reason).toBeNull();
  expect(document.activities).toEqual([
    {
      activity_id: activity,
      kind: "tool",
      label: "Read files",
      action: "read_file",
      subject: null,
      started_at: at.toISOString(),
      ended_at: null,
      outcome: "completed",
    },
  ]);
  expect(document.messages[3]?.identity?.fact).toEqual({
    type: "turn_terminal",
    outcome: "completed",
    reason: "finished",
  });
});

test("a message without identity is its own record", () => {
  const document = buildRecordDocument({
    request: null,
    status: "message",
    reason: null,
    firstSeq: 1,
    startedAt: null,
    endedAt: at,
    messages: [{ messageId: "agentapi:3", role: "user", content: "hi", occurredAt: at, metadata: {}, identity: null }],
  });
  expect(document).toMatchObject({ turn_id: null, request: null, status: "message", final_response: null });
  expect(document.messages).toEqual([
    {
      seq: 1,
      message_id: "agentapi:3",
      role: "user",
      content: "hi",
      occurred_at: at.toISOString(),
      metadata: {},
      identity: null,
    },
  ]);
});
