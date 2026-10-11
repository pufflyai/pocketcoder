import { describe, expect, test } from "bun:test";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { authed, createTestBody, createTestServer } from "../testing/test-server.test";
import { fakeAgent, readyWorkspace, respondJson } from "./relay-fixtures.test";

const createStore = createTestStoreFactory();

describe("service relay", () => {
  test("workspace not ready returns 409; terminal returns 410", async () => {
    const server = await createTestServer(await createStore());
    const res = await server.app.request(
      "/v1/workspaces",
      authed(server.token, {
        method: "POST",
        headers: { "idempotency-key": "r1" },
        body: createTestBody(),
      }),
    );
    const ws = (await res.json()) as { id: string };
    const notReady = await server.app.request(`/v1/workspaces/${ws.id}/services/agent/status`, authed(server.token));
    expect(notReady.status).toBe(409);

    await server.app.request(`/v1/workspaces/${ws.id}/cancel`, authed(server.token, { method: "POST" }));
    const terminal = await server.app.request(`/v1/workspaces/${ws.id}/services/agent/status`, authed(server.token));
    expect(terminal.status).toBe(410);
  });

  test("ready but disconnected returns 503", async () => {
    const server = await createTestServer(await createStore());
    const id = await readyWorkspace(server);
    const res = await server.app.request(`/v1/workspaces/${id}/services/agent/status`, authed(server.token));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("workspace.disconnected");
  });

  test("undeclared routes and query fields are rejected with 422", async () => {
    const server = await createTestServer(await createStore());
    const id = await readyWorkspace(server);
    fakeAgent(server, id, () => {});
    const badRoute = await server.app.request(`/v1/workspaces/${id}/services/agent/shell`, authed(server.token));
    expect(badRoute.status).toBe(422);

    const badMethod = await server.app.request(
      `/v1/workspaces/${id}/services/agent/status`,
      authed(server.token, { method: "DELETE" }),
    );
    expect(badMethod.status).toBe(422);

    const badQuery = await server.app.request(
      `/v1/workspaces/${id}/services/agent/status?redirect=http://evil`,
      authed(server.token),
    );
    expect(badQuery.status).toBe(422);
  });

  test("oversized request body returns 413", async () => {
    const server = await createTestServer(await createStore());
    const id = await readyWorkspace(server);
    fakeAgent(server, id, () => {});
    const res = await server.app.request(
      `/v1/workspaces/${id}/services/agent/message`,
      authed(server.token, {
        method: "POST",
        body: JSON.stringify({ content: "x".repeat(70_000) }),
      }),
    );
    expect(res.status).toBe(413);
  });

  test("relays a declared route through the live connection", async () => {
    const server = await createTestServer(await createStore());
    const id = await readyWorkspace(server);
    fakeAgent(server, id, (frame) => {
      respondJson(server, id, frame, { status: "stable" });
    });
    const res = await server.app.request(`/v1/workspaces/${id}/services/agent/status`, authed(server.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "stable" });
  });

  test("offers a direct AgentAPI alias without exposing the service abstraction", async () => {
    const server = await createTestServer(await createStore());
    const id = await readyWorkspace(server);
    const { sent } = fakeAgent(server, id, (frame) => {
      respondJson(server, id, frame, { status: "stable" });
    });
    const res = await server.app.request(`/v1/workspaces/${id}/agent/status`, authed(server.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "stable" });
    expect(sent.map((value) => JSON.parse(value) as { payload: { service: string; path: string } })).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ service: "agent", path: "/status" }),
      }),
    );
  });

  test("streams a declared AgentAPI event response before upstream EOF", async () => {
    const server = await createTestServer(await createStore());
    const id = await readyWorkspace(server);
    let requestId = "";
    const { conn } = fakeAgent(server, id, (frame) => {
      requestId = frame.payload.request_id;
      server.hub.startRelayStream(conn, {
        request_id: requestId,
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      });
    });
    const response = await server.app.request(
      `/v1/workspaces/${id}/agent/events`,
      authed(server.token, { headers: { accept: "text/event-stream" } }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    if (!response.body) throw new Error("expected streamed body");
    const reader = response.body.getReader();

    server.hub.pushRelayStreamChunk(conn, {
      request_id: requestId,
      seq: 0,
      content_b64: Buffer.from("data: first\n\n").toString("base64"),
    });
    expect(Buffer.from((await reader.read()).value ?? []).toString()).toBe("data: first\n\n");
    server.hub.pushRelayStreamChunk(conn, {
      request_id: requestId,
      seq: 1,
      content_b64: Buffer.from("data: second\n\n").toString("base64"),
    });
    expect(Buffer.from((await reader.read()).value ?? []).toString()).toBe("data: second\n\n");
    server.hub.endRelayStream(conn, { request_id: requestId });
    expect((await reader.read()).done).toBe(true);
  });

  test("returns a compatibility error for streaming through a protocol-v4 supervisor", async () => {
    const server = await createTestServer(await createStore());
    const id = await readyWorkspace(server);
    fakeAgent(server, id, () => {}, 4);
    const response = await server.app.request(`/v1/workspaces/${id}/agent/events`, authed(server.token));
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("relay.streaming_unsupported");
  });
});
