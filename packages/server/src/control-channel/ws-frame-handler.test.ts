import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { type AgentFrame, ConversationRequestIdentitySchema, PROTOCOL_VERSION } from "@pstdio/pocketcoder-contracts";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import type { WSContext } from "hono/ws";
import { authed, createTestBody, createTestServer, SERVER_TEST_PEPPER } from "../testing/test-server.test";
import { handleConnectedFrame } from "./ws-frame-handler";

const createStore = createTestStoreFactory();

// Control-channel wiring: identity and retention must both survive decoded frames.
test.each([
  ...(["retained", "deleted", "purged", "missing"] as const).map((history) => ({ history, identified: false })),
  { history: "retained" as const, identified: true },
])(
  "a received transcript frame respects $history history (identified=$identified)",
  async ({ history, identified }) => {
    const server = await createTestServer(await createStore(), { globalActiveWorkspaces: 0 });
    const response = await server.app.request(
      "/v1/workspaces",
      authed(server.token, {
        method: "POST",
        headers: { "idempotency-key": "queued-history" },
        body: createTestBody(),
      }),
    );
    const { id } = (await response.json()) as { id: string };
    const row = await server.store.getWorkspace(id);
    if (!row) throw new Error("workspace missing");
    const socket = { send() {}, close() {} } as unknown as WSContext;
    const connection = server.hub.attach(id, "history-connection", 1, socket);
    const frame: Extract<AgentFrame, { type: "conversation_message" }> = {
      v: PROTOCOL_VERSION,
      type: "conversation_message" as const,
      workspace_id: id,
      connection_id: connection.connectionId,
      seq: 2,
      sent_at: new Date().toISOString(),
      payload: {
        message_id: "agentapi:3",
        role: "user" as const,
        content: "accepted before Stop",
        occurred_at: new Date().toISOString(),
        metadata: {},
      },
    };
    const identity = {
      schema: "pocketcoder.conversation/v2" as const,
      authority: "external" as const,
      conversation_id: id,
      request_id: "10000000-0000-4000-8000-000000000002",
      turn_id: "10000000-0000-4000-8000-000000000003",
      request_fingerprint: "a".repeat(64),
      event_id: "10000000-0000-4000-8000-000000000004",
      message_id: "agentapi:3",
      sequence: 1,
      revision: 1,
    };
    if (identified) {
      await server.store.acceptConversationRequest(id, ConversationRequestIdentitySchema.parse(identity), new Date());
      frame.payload.identity = identity;
    }
    let release!: () => void;
    const earlierWork = new Promise<void>((resolve) => {
      release = resolve;
    });
    const receive = () =>
      handleConnectedFrame({ ...server, pepper: SERVER_TEST_PEPPER }, connection, socket, frame, () => {});
    const pending = earlierWork.then(receive);
    await server.scheduler.finalize(row, "canceled", "canceled_by_caller", new Date());
    if (history === "deleted") await server.store.deleteConversation(id, new Date());
    if (history === "purged") {
      const at = new Date();
      await server.store.insertOperation({
        id: randomUUID(),
        principalId: row.principalId,
        workspaceId: id,
        kind: "purge",
        state: "pending",
        idempotencyKey: "purge-history",
        requestDigest: "purge-history",
        checkpointId: null,
        resultWorkspaceId: null,
        reasonCode: null,
        attemptCount: 0,
        createdAt: at,
        updatedAt: at,
        completedAt: null,
      });
    }
    if (history === "missing") frame.workspace_id = randomUUID();
    release();
    await pending;
    await receive();
    const messages = await server.store.readConversation(id, 0, 10);
    if (history === "retained") expect(messages[0]?.identity).toEqual(identified ? identity : undefined);
    expect((await server.store.getWorkspace(id))?.state).toBe("canceled");
    expect(messages.map((message) => message.content)).toEqual(history === "retained" ? ["accepted before Stop"] : []);
  },
);
