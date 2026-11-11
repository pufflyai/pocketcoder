import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readSessionMessages } from "./messages";

test("selected live history and large stored history fit the connection response limit", async () => {
  const conversationId = randomUUID();
  const messages = Array.from({ length: 14 }, (_, i) => ({
    message_id: `m-${i}`,
    role: "assistant",
    content: "x".repeat(200 * 1024),
    parts: [{ type: "text", text: "x".repeat(200 * 1024) }],
    occurred_at: new Date(i).toISOString(),
    metadata: {},
  }));
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/conversation/open"))
        return Response.json({
          turns:
            url.searchParams.get("conversationId") === conversationId
              ? []
              : [{ conversation_id: randomUUID(), messages }],
        });
      const start = Number(url.searchParams.get("cursor") ?? 0),
        limit = Number(url.searchParams.get("limit") ?? 200),
        end = Math.min(start + limit, messages.length);
      return Response.json({
        items: messages.slice(start, end),
        next_cursor: end < messages.length ? String(end) : null,
      });
    },
  });
  try {
    const rendered = await readSessionMessages(
      async <T>(path: string) => {
        const response = await fetch(new URL(path, server.url));
        const bytes = await response.bytes();
        if (bytes.length > 5 * 1024 * 1024) throw new Error("Connection response body is too large.");
        return JSON.parse(new TextDecoder().decode(bytes)) as T;
      },
      randomUUID(),
      conversationId,
    );
    expect(rendered).toHaveLength(messages.length);
    expect(rendered.at(-1)?.id).toBe("m-13");
  } finally {
    await server.stop(true);
  }
});
