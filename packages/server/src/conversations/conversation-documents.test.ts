import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { ConversationFact, ConversationLiveEvent } from "@pstdio/pocketcoder-contracts";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { ConversationGoneError, PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { authed, createTestBody, createTestServer } from "../testing/test-server.test";

const createStore = createTestStoreFactory();

async function setup() {
  const server = await createTestServer(await createStore(), { globalActiveWorkspaces: 0 });
  const created = await server.app.request(
    "/v1/workspaces",
    authed(server.token, { method: "POST", headers: { "idempotency-key": "chats" }, body: createTestBody("chats") }),
  );
  const { id } = (await created.json()) as { id: string };
  const client = new PocketCoderClient({ baseUrl: "http://runtime.test", apiKey: server.token }, ((input, init) =>
    server.app.request(String(input), init)) as typeof fetch);
  // A producer turn as the supervisor forwards it: one frame per event revision.
  async function turn(conversationId: string, text: string, terminal = true) {
    const identity = {
      schema: "pocketcoder.conversation/v2" as const,
      authority: "external" as const,
      conversation_id: conversationId,
      request_id: randomUUID(),
      turn_id: randomUUID(),
      request_fingerprint: "a".repeat(64),
    };
    await client.conversations.acceptRequest(id, identity);
    const send = (sequence: number, content: string, fact?: ConversationFact) =>
      server.liveTurns.receive(id, {
        message_id: `${text}-${sequence}`,
        role: "assistant",
        content,
        occurred_at: new Date().toISOString(),
        metadata: {},
        identity: {
          ...identity,
          event_id: randomUUID(),
          message_id: `${text}-${sequence}`,
          sequence,
          revision: 1,
          ...(fact ? { fact } : {}),
        },
      });
    await send(0, text, { type: "final_response" });
    if (terminal) await send(1, "", { type: "turn_terminal", outcome: "completed" });
    return send;
  }
  return { server, id, client, turn };
}

test("two conversations in one workspace interleave and read back separately", async () => {
  const { id, client, turn } = await setup();
  const [a, b] = [randomUUID(), randomUUID()];
  await turn(a, "a1");
  await turn(b, "b1");
  await turn(a, "a2");
  await turn(b, "b2");
  const listed = await client.conversations.listConversations(id);
  expect(listed.map((row) => [row.conversation_id, row.turn_count]).sort()).toEqual(
    [
      [a, 2],
      [b, 2],
    ].sort(),
  );
  const first = await client.conversations.read(id, a, { limit: 3 });
  expect(first.items.map((message) => [message.seq, message.content])).toEqual([
    [1, "a1"],
    [2, ""],
    [3, "a2"],
  ]);
  const rest = await client.conversations.read(id, a, { cursor: first.nextCursor ?? undefined });
  expect(rest.items.map((message) => message.seq)).toEqual([4]);
  expect(rest.nextCursor).toBeNull();
  expect((await client.conversations.read(id, b)).items.map((message) => message.content)).toEqual([
    "b1",
    "",
    "b2",
    "",
  ]);
  // The workspace history keeps its existing shape and order.
  expect((await client.conversations.list(id)).items.map((message) => message.content)).toEqual([
    "a1",
    "",
    "b1",
    "",
    "a2",
    "",
    "b2",
    "",
  ]);
});

test("the live tail streams the open turn, then its commit", async () => {
  const { id, client, turn } = await setup();
  const conversation = randomUUID();
  const events: ConversationLiveEvent[] = [];
  const reading = (async () => {
    for await (const event of client.conversations.live(id, { conversationId: conversation })) {
      events.push(event);
      if (event.type === "committed") break;
    }
  })();
  await Bun.sleep(50);
  const send = await turn(conversation, "streamed", false);
  await send(1, "", { type: "turn_terminal", outcome: "completed" });
  await reading;
  expect(events.map((event) => event.type)).toEqual(["turn", "turn", "committed"]);
  expect(events[0]).toMatchObject({ type: "turn", conversation_id: conversation, messages: [{ content: "streamed" }] });
  expect(events.at(-1)).toMatchObject({ type: "committed", status: "completed", last_seq: 2 });
});

test("deleting one conversation leaves the other readable", async () => {
  const { id, client, turn } = await setup();
  const [kept, removed] = [randomUUID(), randomUUID()];
  await turn(kept, "keep");
  await turn(removed, "remove");
  await client.conversations.delete(id, removed);
  await client.conversations.delete(id, removed);
  await expect(client.conversations.read(id, removed)).rejects.toBeInstanceOf(ConversationGoneError);
  expect((await client.conversations.read(id, kept)).items).toHaveLength(2);
  await expect(client.conversations.read(id, randomUUID())).rejects.toMatchObject({ code: "conversation.not_found" });
});
