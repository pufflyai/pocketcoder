import { expect, test } from "bun:test";
import { readAgentApiEvents } from "./agentapi-events";

const identity = {
  schema: "pocketcoder.conversation/v2" as const,
  authority: "external" as const,
  conversation_id: "10000000-0000-4000-8000-000000000001",
  request_id: "10000000-0000-4000-8000-000000000002",
  turn_id: "10000000-0000-4000-8000-000000000003",
  request_fingerprint: "a".repeat(64),
  event_id: "10000000-0000-4000-8000-000000000004",
  message_id: "answer-1",
  sequence: 1,
  revision: 1,
};

test.each([
  { type: "intermediate" },
  { type: "final_response" },
  { type: "tool_only" },
  {
    type: "activity_started",
    activity_id: identity.event_id,
    kind: "tool",
    label: "Read selected files",
    started_at: null,
  },
  { type: "activity_finished", activity_id: identity.event_id, ended_at: "2026-10-13T12:01:00Z", outcome: "completed" },
  { type: "turn_terminal", outcome: "interrupted" },
] as const)("decodes explicit $type facts without deriving progress from text", async (fact) => {
  const data = {
    message_id: "event-1:1",
    role: "assistant" as const,
    content: "Observed output",
    occurred_at: "2026-10-13T12:00:00Z",
    metadata: {},
    identity: { ...identity, fact },
  };
  const body = new Response(`event: conversation_message\ndata: ${JSON.stringify(data)}\n\n`).body;
  if (!body) throw new Error("stream missing");
  const events = [];
  for await (const event of readAgentApiEvents(body, new AbortController().signal)) events.push(event);
  expect(events).toEqual([{ event: "conversation_message", data }]);
});

test("cancels the provider reader when a consumer finishes before stream end", async () => {
  let canceled = false;
  const data = {
    message_id: "event-1:1",
    role: "assistant" as const,
    content: "",
    occurred_at: "2026-10-13T12:00:00Z",
    metadata: {},
    identity: { ...identity, fact: { type: "turn_terminal", outcome: "completed" } },
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`event: conversation_message\ndata: ${JSON.stringify(data)}\n\n`));
    },
    cancel() {
      canceled = true;
    },
  });
  for await (const _event of readAgentApiEvents(body, new AbortController().signal)) break;
  expect(canceled).toBe(true);
  expect(body.locked).toBe(false);
});
