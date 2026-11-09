import { randomUUID } from "node:crypto";

// A real local HTTP provider with count, JSON and streaming routes. It journals every request so
// tests can prove that denied calls never reached generation and that nothing was sent twice.
export type ProviderMode = "complete" | "drop-before-usage" | "hold" | "fail" | "no-count";
export interface JournalEntry {
  path: string;
  authorization: string | null;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const encoder = new TextEncoder();
const sse = (event: Record<string, unknown>) =>
  encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

export function providerFixture(options: { inputTokens: number; outputTokens: number }) {
  const journal: JournalEntry[] = [];
  const held: (() => void)[] = [];
  let mode: ProviderMode = "complete";
  const response = (id: string, status: string, usage: boolean) => ({
    id,
    object: "response",
    status,
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "fixture answer" }] }],
    ...(usage ? { usage: { input_tokens: options.inputTokens, output_tokens: options.outputTokens } } : {}),
  });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = (await request.json()) as Record<string, unknown>;
      journal.push({
        path,
        authorization: request.headers.get("authorization"),
        headers: Object.fromEntries(request.headers),
        body,
      });
      if (path === "/v1/responses/input_tokens") {
        if (mode === "no-count") return Response.json({ object: "response.input_tokens" });
        return Response.json({ object: "response.input_tokens", input_tokens: options.inputTokens });
      }
      if (path !== "/v1/responses") return new Response("not found", { status: 404 });
      if (mode === "fail") return Response.json({ error: { message: "upstream failure" } }, { status: 500 });
      const id = `resp_${randomUUID()}`;
      if (body.stream !== true) {
        if (mode === "hold") await new Promise<void>((resolve) => held.push(resolve));
        return Response.json(response(id, "completed", mode !== "drop-before-usage"));
      }
      const current = mode;
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(sse({ type: "response.created", response: response(id, "in_progress", false) }));
            controller.enqueue(sse({ type: "response.output_text.delta", delta: "fixture " }));
            if (current === "drop-before-usage") {
              // Let the first events reach the client before the connection breaks.
              await Bun.sleep(50);
              return controller.error(new Error("connection dropped"));
            }
            if (current === "hold") await new Promise<void>((resolve) => held.push(resolve));
            controller.enqueue(sse({ type: "response.completed", response: response(id, "completed", true) }));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    journal,
    generations: () => journal.filter((entry) => entry.path === "/v1/responses"),
    setMode(next: ProviderMode) {
      mode = next;
    },
    heldCount: () => held.length,
    release() {
      for (const resolve of held.splice(0)) resolve();
    },
    stop: () => server.stop(true),
  };
}

export async function until(check: () => Promise<boolean> | boolean, timeoutMs = 5_000) {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Condition was not met in time");
    await Bun.sleep(10);
  }
}
