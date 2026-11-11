import { expect, test } from "bun:test";
import { sessionMessages } from "./session-messages";

test("the Lab renders canonical parts without interpreting text as a protocol", () => {
  const rendered = sessionMessages([
    {
      message_id: "message-1",
      role: "assistant",
      content: "",
      occurred_at: new Date().toISOString(),
      metadata: {},
      parts: [
        { type: "text", text: "**Hello** <ot>literal</ot>" },
        {
          type: "tool",
          call_id: "call-1",
          name: "bash",
          status: "completed",
          input: { command: "echo hello" },
          output: { text: "hello\n" },
          output_text: "hello\n",
        },
        { type: "error", code: "provider_error", message: "retry failed" },
      ],
    },
  ]);
  expect(rendered[0]?.parts).toEqual([
    { type: "text", text: "**Hello** <ot>literal</ot>" },
    {
      type: "tool",
      tool: "bash",
      callId: "call-1",
      status: "completed",
      state: { status: "completed", input: { command: "echo hello" }, output: "hello\n" },
    },
    { type: "error", errorType: "other", message: "retry failed" },
  ]);
});
