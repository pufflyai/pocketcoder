import { expect, test } from "bun:test";
import type {
  ConversationFact,
  ConversationMessageInput,
  ConversationRequestIdentity,
} from "@pstdio/pocketcoder-contracts";
import { RemoteAgentClient } from "./client";

const identity: ConversationRequestIdentity = {
  schema: "pocketcoder.conversation/v2",
  authority: "external",
  conversation_id: "10000000-0000-4000-8000-000000000001",
  request_id: "10000000-0000-4000-8000-000000000002",
  turn_id: "10000000-0000-4000-8000-000000000003",
  request_fingerprint: "a".repeat(64),
};

function message(sequence: number, fact: ConversationFact, content = ""): ConversationMessageInput {
  return {
    message_id: `event-${sequence}`,
    role: "assistant",
    content,
    occurred_at: "2026-10-13T12:00:00Z",
    metadata: {},
    identity: {
      ...identity,
      event_id: `10000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
      message_id: "answer",
      sequence,
      revision: 1,
      fact,
    },
  };
}

function provider(events: ConversationMessageInput[]) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const requests: Request[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    requests.push(request);
    const path = new URL(request.url).pathname;
    if (path.endsWith("/events")) return new Response(stream);
    if (path.endsWith("/status")) return Response.json({ status: "stable" });
    if (path.endsWith("/message") && request.method === "POST") {
      queueMicrotask(() => {
        controller.enqueue(
          new TextEncoder().encode(
            `event: status_change\ndata: {"status":"stable"}\n\n` +
              events.map((event) => `event: conversation_message\ndata: ${JSON.stringify(event)}\n\n`).join(""),
          ),
        );
      });
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return {
    requests,
    client: new RemoteAgentClient(
      { serviceUrl: "http://agent.test", key: "workspace-scoped", timeoutMs: 1000 },
      fetchImpl,
    ),
  };
}

test.each([
  { outcome: "completed", final: true, toolOnly: false },
  { outcome: "interrupted", final: true, toolOnly: false },
  { outcome: "failed", final: false, toolOnly: false },
  { outcome: "completed", final: false, toolOnly: true },
] as const)(
  "retains explicit $outcome outcome (final=$final, toolOnly=$toolOnly)",
  async ({ outcome, final, toolOnly }) => {
    const intermediate = message(1, { type: "intermediate" }, "ongoing work");
    const unrelated = message(9, { type: "turn_terminal", outcome: "failed" });
    if (!unrelated.identity) throw new Error("identity missing");
    unrelated.identity.turn_id = "10000000-0000-4000-8000-000000000099";
    const events = [unrelated, intermediate, intermediate];
    const finalResponse = final ? message(2, { type: "final_response" }, "preserved final text") : null;
    if (finalResponse?.identity) {
      const earlier = { ...finalResponse, content: "partial final", identity: { ...finalResponse.identity } };
      finalResponse.identity.revision = 2;
      const replayedFinal = message(8, { type: "final_response" }, "older explicit final");
      if (!replayedFinal.identity) throw new Error("identity missing");
      replayedFinal.identity.sequence = 0;
      events.push(earlier, finalResponse, earlier, replayedFinal);
    }
    if (toolOnly) events.push(message(3, { type: "tool_only" }));
    events.push(message(4, { type: "turn_terminal", outcome }));
    const { client, requests } = provider(events);
    const observed: ConversationMessageInput[] = [];
    const result = await client.sendTurn("work", identity, { onEvent: (event) => observed.push(event) });
    expect(result).toEqual({ identity, outcome, finalResponse, toolOnly });
    expect(observed).toEqual(events.filter((_, index) => index !== 0 && index !== 2 && !(final && index === 5)));
    const submitted = requests.find((request) => request.method === "POST");
    expect(await submitted?.json()).toEqual({ type: "user", content: "work", identity });
    expect(requests.some((request) => new URL(request.url).pathname.endsWith("/messages"))).toBe(false);
  },
);
