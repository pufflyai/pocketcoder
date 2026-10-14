import { expect, test } from "bun:test";
import { RemoteAgentClient } from "./client";

test("a quiet stable provider and final text cannot complete an identified turn before its terminal fact", async () => {
  const identity = {
    schema: "pocketcoder.conversation/v2",
    authority: "external",
    conversation_id: "10000000-0000-4000-8000-000000000001",
    request_id: "10000000-0000-4000-8000-000000000002",
    turn_id: "10000000-0000-4000-8000-000000000003",
    request_fingerprint: "a".repeat(64),
  } as const;
  const event = (sequence: number, type: "final_response" | "turn_terminal") => ({
    message_id: `event-${sequence}`,
    role: "assistant",
    content: type === "final_response" ? "Done." : "",
    occurred_at: "2026-10-14T12:00:00Z",
    metadata: {},
    identity: {
      ...identity,
      event_id: `10000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
      message_id: "answer",
      sequence,
      revision: 1,
      fact: type === "final_response" ? { type } : { type, outcome: "completed" },
    },
  });
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let observed!: () => void;
  const finalSeen = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const emit = (sequence: number, type: "final_response" | "turn_terminal") =>
    controller.enqueue(
      new TextEncoder().encode(`event: conversation_message\ndata: ${JSON.stringify(event(sequence, type))}\n\n`),
    );
  let posts = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/status") return Response.json({ status: "stable" });
      if (path === "/events")
        return new Response(
          new ReadableStream({
            start(value) {
              controller = value;
              controller.enqueue(new TextEncoder().encode(": connected\n\n"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      if (path === "/message") {
        posts += 1;
        expect(await request.json()).toEqual({ type: "user", content: "work", identity });
        controller.enqueue(new TextEncoder().encode('event: status_change\ndata: {"status":"stable"}\n\n'));
        emit(1, "final_response");
        return Response.json({ ok: true });
      }
      return new Response(null, { status: 404 });
    },
  });
  let settled = false;
  const client = new RemoteAgentClient({ serviceUrl: server.url.toString(), key: "synthetic", timeoutMs: 2000 });
  const turn = client.sendTurn("work", identity, { onEvent: () => observed() }).then((result) => {
    settled = true;
    return result;
  });
  try {
    await finalSeen;
    expect(settled).toBe(false);
    emit(2, "turn_terminal");
    expect(await turn).toMatchObject({ outcome: "completed", finalResponse: { content: "Done." } });
    expect(posts).toBe(1);
  } finally {
    server.stop(true);
    await turn.catch(() => {});
  }
});
