import { describe, expect, test } from "bun:test";
import { agentApiConversationMessages } from "./agentapi";

describe("AgentAPI transcript projection", () => {
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
