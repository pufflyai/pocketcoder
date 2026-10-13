import { expect, test } from "bun:test";
import { ConversationRequestReceiptSchema } from "@pstdio/pocketcoder-contracts";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { authed, createTestBody, createTestServer } from "../testing/test-server.test";

// API wiring and authorization: retries return the same durable receipt, and
// history projections retain identities rather than guessing from message text.
test("reconciles an owned request through the API and returns explicit legacy history", async () => {
  const server = await createTestServer({ globalActiveWorkspaces: 0 });
  const created = await server.app.request(
    "/v1/workspaces",
    authed(server.token, {
      method: "POST",
      headers: { "idempotency-key": "request-history" },
      body: createTestBody("request-history"),
    }),
  );
  const { id } = (await created.json()) as { id: string };
  const identity = {
    schema: "pocketcoder.conversation/v2" as const,
    authority: "external" as const,
    conversation_id: id,
    request_id: "10000000-0000-4000-8000-000000000002",
    turn_id: "10000000-0000-4000-8000-000000000003",
    request_fingerprint: "a".repeat(64),
  };
  const path = `/v1/workspaces/${id}/conversation/requests`;
  const post = (token: string, body = identity) =>
    server.app.request(path, authed(token, { method: "POST", body: JSON.stringify(body) }));
  const first = await post(server.token);
  expect(first.status).toBe(201);
  const accepted = ConversationRequestReceiptSchema.parse(await first.json());
  expect(accepted).toMatchObject({ kind: "accepted", identity });
  const client = new PocketCoderClient({ baseUrl: "http://runtime.test", apiKey: server.token }, ((input, init) =>
    server.app.request(String(input), init)) as typeof fetch);
  expect(await client.conversations.acceptRequest(id, identity)).toEqual({ ...accepted, kind: "replayed" });
  const replay = await post(server.token);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual({ ...accepted, kind: "replayed" });
  expect((await post(server.token, { ...identity, request_fingerprint: "b".repeat(64) })).status).toBe(409);
  expect((await post(server.limitedToken)).status).toBe(403);

  const at = new Date("2026-10-13T12:00:00Z");
  const messageIdentity = {
    ...identity,
    event_id: "10000000-0000-4000-8000-000000000004",
    message_id: "answer",
    sequence: 1,
    revision: 1,
  };
  for (const [messageId, identified] of [
    ["answer", true],
    ["older-message", false],
  ] as const) {
    await server.store.appendConversationMessage({
      workspaceId: id,
      messageId,
      role: "assistant",
      content: "Answer",
      occurredAt: at,
      metadata: {},
      createdAt: at,
      ...(identified ? { identity: messageIdentity } : {}),
    });
  }
  const history = await server.app.request(`/v1/workspaces/${id}/conversation`, authed(server.token));
  const body = (await history.json()) as { items: { identity: unknown }[] };
  expect(body.items.map((item) => item.identity)).toEqual([messageIdentity, null]);
  const decoded = await client.conversations.list(id);
  expect(decoded.items.map((item) => item.identity)).toEqual([messageIdentity, null]);
  expect(decoded.protocol).not.toBeNull();
});
