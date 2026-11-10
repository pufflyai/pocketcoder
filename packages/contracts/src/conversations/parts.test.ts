import { expect, test } from "bun:test";
import { ConversationMessageInputSchema } from "./conversation";

test("session messages carry text, tool calls, results and errors without an encoded transcript", () => {
  const message = {
    message_id: "answer-1",
    role: "assistant" as const,
    content: "The company list is empty.",
    parts: [
      { type: "text", text: "Checking companies." },
      {
        type: "tool",
        call_id: "call-1",
        name: "bash",
        status: "completed",
        input: { command: "onefin companies company list" },
        output: { items: [] },
        output_text: "No companies.",
      },
      { type: "text", text: "The company list is empty." },
      { type: "error", code: "provider.unavailable", message: "The provider is unavailable." },
    ],
    occurred_at: new Date().toISOString(),
    metadata: {},
  };
  expect(ConversationMessageInputSchema.parse(message)).toEqual(expect.objectContaining(message));
});

test("the session contract rejects a tool result without its call identity", () => {
  expect(
    ConversationMessageInputSchema.safeParse({
      message_id: "m",
      role: "assistant",
      content: "",
      parts: [{ type: "tool", name: "bash", status: "completed", input: {}, output: "done" }],
      occurred_at: new Date().toISOString(),
      metadata: {},
    }).success,
  ).toBe(false);
});
