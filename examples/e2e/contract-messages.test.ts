import { expect, test } from "bun:test";
import { messageList, observeLiveUpdates, responseText } from "./contract-messages";

test("example clients consume canonical typed messages without decoding terminal markup", async () => {
  const conversation_id = crypto.randomUUID(),
    turn_id = crypto.randomUUID();
  const text = "**Å**\n<ot>literal</ot> \\u0020";
  const message = {
    message_id: crypto.randomUUID(),
    role: "assistant",
    content: text,
    parts: [{ type: "text", text }],
    occurred_at: new Date().toISOString(),
    metadata: {},
    identity: null,
  };
  const events = [
    { type: "turn", conversation_id, turn_id, messages: [message] },
    { type: "committed", conversation_id, turn_id, status: "completed", last_seq: 1 },
  ];
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      }),
  });
  try {
    expect(responseText(messageList([message]), 0)).toBe(text);
    expect(await observeLiveUpdates(await fetch(server.url), conversation_id)).toEqual([text]);
  } finally {
    await server.stop(true);
  }
});
