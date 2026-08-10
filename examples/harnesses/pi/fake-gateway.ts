// Deterministic OpenAI Chat Completions-compatible gateway for the local Pi
// E2E. It asks the real remote Pi agent to use its read tool, then returns the
// fixture contents after Pi supplies the tool result.

export const PI_FIXTURE_CONTENT = "PocketCoder remote workspace fixture: ORBIT-7319";

interface ChatMessage {
  role?: string;
  content?: unknown;
}

interface ChatRequest {
  model?: string;
  stream?: boolean;
  messages?: ChatMessage[];
}

function hasToolResult(body: ChatRequest): boolean {
  return body.messages?.some((message) => message.role === "tool") ?? false;
}

function completion(body: ChatRequest): {
  delta: Record<string, unknown>;
  finishReason: "stop" | "tool_calls";
} {
  if (hasToolResult(body)) {
    return {
      delta: { role: "assistant", content: PI_FIXTURE_CONTENT },
      finishReason: "stop",
    };
  }
  return {
    delta: {
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: "call_read_fixture",
          type: "function",
          function: {
            name: "read",
            arguments: JSON.stringify({ path: "/workspace/test.txt" }),
          },
        },
      ],
    },
    finishReason: "tool_calls",
  };
}

function streamingDeltas(delta: Record<string, unknown>): Record<string, unknown>[] {
  if (typeof delta.content !== "string" || delta.content.length < 2) return [delta];
  const midpoint = Math.ceil(delta.content.length / 2);
  const { content, ...metadata } = delta;
  return [
    { ...metadata, content: content.slice(0, midpoint) },
    { content: content.slice(midpoint) },
  ];
}

export function startFakePiGateway(expectedBearer?: string): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({ ok: true });
      }
      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        return new Response("not found", { status: 404 });
      }
      if (expectedBearer && request.headers.get("authorization") !== `Bearer ${expectedBearer}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const body = (await request.json()) as ChatRequest;
      const model = body.model ?? "pocketcoder-test";
      const created = Math.floor(Date.now() / 1000);
      const next = completion(body);
      if (!body.stream) {
        return Response.json({
          id: "chatcmpl-pocketcoder",
          object: "chat.completion",
          created,
          model,
          choices: [
            {
              index: 0,
              message: next.delta,
              finish_reason: next.finishReason,
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 4, total_tokens: 5 },
        });
      }
      const deltas = streamingDeltas(next.delta);
      const chunks = [
        ...deltas.map((delta) => ({
          id: "chatcmpl-pocketcoder",
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta,
              finish_reason: null,
            },
          ],
        })),
        {
          id: "chatcmpl-pocketcoder",
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: next.finishReason }],
          usage: { prompt_tokens: 1, completion_tokens: 4, total_tokens: 5 },
        },
      ];
      const payloads = [
        ...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`),
        "data: [DONE]\n\n",
      ];
      let canceled = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          void (async () => {
            for (const [index, payload] of payloads.entries()) {
              if (index > 0) await Bun.sleep(350);
              if (canceled) return;
              controller.enqueue(new TextEncoder().encode(payload));
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
    },
  });
}
