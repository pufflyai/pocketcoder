import { describe, expect, test } from "bun:test";
import { agentApiConversationMessages } from "./agentapi";

describe("AgentAPI transcript projection", () => {
  // Provider history wiring: checkpoint synchronization must preserve explicit
  // producer facts and IDs rather than reconstruct a final answer from roles.
  test.each(["unclassified", "final_response", "turn_terminal"] as const)(
    "retains supplied %s facts from canonical provider history",
    (type) => {
      const message = {
        message_id: "event-1:1",
        role: "assistant" as const,
        content: "Preserved text",
        occurred_at: "2026-10-13T12:00:00Z",
        metadata: {},
        identity: {
          schema: "pocketcoder.conversation/v2" as const,
          authority: "external" as const,
          conversation_id: "10000000-0000-4000-8000-000000000001",
          request_id: "10000000-0000-4000-8000-000000000002",
          turn_id: "10000000-0000-4000-8000-000000000003",
          request_fingerprint: "a".repeat(64),
          event_id: "10000000-0000-4000-8000-000000000004",
          message_id: "answer",
          sequence: 1,
          revision: 1,
          ...(type === "unclassified"
            ? {}
            : {
                fact: type === "final_response" ? { type } : { type, outcome: "interrupted" as const },
              }),
        },
      };
      expect(agentApiConversationMessages({ messages: [message] })).toEqual([message]);
    },
  );
  test("projects stable AgentAPI history to canonical durable messages", () => {
    expect(
      agentApiConversationMessages({
        messages: [
          { id: 1, role: "user", content: "Inspect it", time: "2026-08-03T12:00:00Z" },
          { id: 2, role: "agent", content: "Done", time: "2026-08-03T12:01:00Z" },
        ],
      }),
    ).toEqual([
      {
        message_id: "agentapi:1",
        role: "user",
        content: "Inspect it",
        occurred_at: "2026-08-03T12:00:00.000Z",
        metadata: { provider: "agentapi", agentapi_id: "1" },
      },
      {
        message_id: "agentapi:2",
        role: "assistant",
        content: "Done",
        occurred_at: "2026-08-03T12:01:00.000Z",
        metadata: { provider: "agentapi", agentapi_id: "2" },
      },
    ]);
  });

  test("drops malformed messages instead of emitting partial transcript data", () => {
    expect(
      agentApiConversationMessages({
        messages: [
          { id: 1, role: "agent", content: "complete", time: "2026-08-03T12:00:00Z" },
          { id: 2, role: "tool", content: "invalid", time: "2026-08-03T12:00:00Z" },
        ],
      }),
    ).toHaveLength(1);
  });
});
