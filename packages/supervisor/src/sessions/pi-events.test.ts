import { expect, test } from "bun:test";
import { PiEvents } from "./pi-events";

test("Pi JSON events retain markdown, Unicode, call IDs, and complete tool results", () => {
  const events = new PiEvents();
  events.receive({ type: "message_start", message: { role: "assistant", content: [] } });
  expect(events.receive({ type: "message_start", message: { role: "user", content: "hello" } })).toBeNull();
  expect(
    events.receive({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "**Hello** å\n<ot>literal</ot>" },
    }),
  ).toEqual({
    key: "assistant:0",
    role: "assistant",
    parts: [{ type: "text", text: "**Hello** å\n<ot>literal</ot>" }],
  });
  expect(
    events.receive({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "onefin companies company list" },
    })?.parts[0],
  ).toMatchObject({
    type: "tool",
    call_id: "call-1",
    name: "bash",
    status: "running",
    input: { command: "onefin companies company list" },
  });
  const output = { content: [{ type: "text", text: "x".repeat(10_000) }], details: { total: 1 } };
  expect(
    events.receive({ type: "tool_execution_update", toolCallId: "call-1", partialResult: output })?.parts[0],
  ).toMatchObject({ status: "running", output });
  expect(
    events.receive({ type: "tool_execution_end", toolCallId: "call-1", result: output, isError: false })?.parts[0],
  ).toMatchObject({ type: "tool", call_id: "call-1", status: "completed", output });
  expect(events.receive({ type: "agent_settled" })).toBeNull();
  expect(events.settled).toBe(true);
});

test("a provider retry can recover before Pi settles", () => {
  const events = new PiEvents();
  events.receive({
    type: "message_end",
    message: { role: "assistant", content: [], stopReason: "error", errorMessage: "try again" },
  });
  expect(events.failure).toBe("try again");
  events.receive({ type: "auto_retry_start" });
  events.receive({ type: "message_start", message: { role: "assistant", content: [] } });
  events.receive({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "recovered" }], stopReason: "stop" },
  });
  events.receive({ type: "agent_settled" });
  expect(events.failure).toBeNull();
  expect(events.finalMessage?.parts).toEqual([{ type: "text", text: "recovered" }]);
});

test("a tool-only turn never promotes earlier narration to a final response", () => {
  const events = new PiEvents();
  events.receive({ type: "message_start", message: { role: "assistant", content: [] } });
  events.receive({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "Let me check" }], stopReason: "toolUse" },
  });
  events.receive({ type: "agent_settled" });
  expect(events.finalMessage).toBeNull();
});

test("Pi self-abort and handled commands settle without a fabricated final reply", () => {
  const events = new PiEvents();
  events.receive({ type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted" } });
  events.receive({ type: "agent_settled" });
  expect(events.aborted).toBe(true);
  expect(events.finalMessage).toBeNull();
  const handled = new PiEvents();
  handled.receive({ type: "response", command: "prompt", success: true, data: { disposition: "handled" } });
  expect(handled.settled).toBe(true);
  expect(handled.finalMessage).toBeNull();
});

test("Pi tool events provide a plain text preview beside the complete structured result", () => {
  const events = new PiEvents();
  events.receive({
    type: "tool_execution_start",
    toolCallId: "preview",
    toolName: "bash",
    args: { command: "onefin companies company list" },
  });
  const result = { content: [{ type: "text", text: '{"items":[]}\n' }], details: { exitCode: 0 } };
  expect(
    events.receive({ type: "tool_execution_end", toolCallId: "preview", result, isError: false })?.parts[0],
  ).toMatchObject({ output: result, output_text: '{"items":[]}\n' });
});
