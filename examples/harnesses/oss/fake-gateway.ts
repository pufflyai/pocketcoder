// Deterministic model gateway for the real Codex and OpenCode container E2Es.
// Codex uses Responses SSE; OpenCode's compatible provider uses Chat
// Completions SSE. Delayed deltas let the test prove AgentAPI live updates.

export const OSS_FIXTURE_CONTENT = "PocketCoder OSS harness fixture: NEBULA-4821";

function splitText(text: string): [string, string] {
  const midpoint = Math.ceil(text.length / 2);
  return [text.slice(0, midpoint), text.slice(midpoint)];
}

function event(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function responsesPayloads(): string[] {
  const id = "resp_pocketcoder_oss";
  const messageId = "msg_pocketcoder_oss";
  const [first, second] = splitText(OSS_FIXTURE_CONTENT);
  return [
    event("response.created", { response: { id } }),
    event("response.output_item.added", {
      item: { type: "message", role: "assistant", id: messageId, content: [] },
    }),
    event("response.output_text.delta", { delta: first }),
    event("response.output_text.delta", { delta: second }),
    event("response.output_item.done", {
      item: {
        type: "message",
        role: "assistant",
        id: messageId,
        content: [{ type: "output_text", text: OSS_FIXTURE_CONTENT }],
      },
    }),
    event("response.completed", {
      response: {
        id,
        usage: {
          input_tokens: 1,
          input_tokens_details: null,
          output_tokens: 8,
          output_tokens_details: null,
          total_tokens: 9,
        },
      },
    }),
  ];
}

function chatCompletionPayloads(model: string): string[] {
  const created = Math.floor(Date.now() / 1000);
  const [first, second] = splitText(OSS_FIXTURE_CONTENT);
  const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl_pocketcoder_oss",
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
  return [
    chunk({ role: "assistant", content: first }, null),
    chunk({ content: second }, null),
    chunk({}, "stop"),
    "data: [DONE]\n\n",
  ];
}

function streamingResponse(payloads: string[], delayMs: number): Response {
  let canceled = false;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        for (const [index, payload] of payloads.entries()) {
          if (index > 0) await Bun.sleep(delayMs);
          if (canceled) return;
          controller.enqueue(encoder.encode(payload));
        }
        if (!canceled) controller.close();
      })();
    },
    cancel() {
      canceled = true;
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

export function startFakeOssGateway(
  expectedBearer: string,
  delayMs = 350,
): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({ ok: true });
      }
      if (request.headers.get("authorization") !== `Bearer ${expectedBearer}`) {
        return new Response("unauthorized", { status: 401 });
      }
      if (request.method !== "POST") return new Response("not found", { status: 404 });
      if (url.pathname === "/v1/responses") {
        return streamingResponse(responsesPayloads(), delayMs);
      }
      if (url.pathname === "/v1/chat/completions") {
        const body = (await request.json()) as { model?: string };
        return streamingResponse(chatCompletionPayloads(body.model ?? "pocketcoder-test"), delayMs);
      }
      return new Response("not found", { status: 404 });
    },
  });
}
