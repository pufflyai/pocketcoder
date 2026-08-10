import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { WSContext } from "hono/ws";
import { authed, createTestBody, createTestServer, type TestServer } from "./test-server.test";

describe("service relay", () => {
  async function readyWorkspace(server: TestServer) {
    const res = await server.app.request(
      "/v1/workspaces",
      authed(server.token, {
        method: "POST",
        headers: { "idempotency-key": randomUUID() },
        body: createTestBody(),
      }),
    );
    const ws = (await res.json()) as { id: string };
    await server.scheduler.tick();
    const now = new Date();
    await server.store.transition(ws.id, { from: ["provisioning"], to: "connected", at: now });
    await server.store.transition(ws.id, {
      from: ["connected"],
      to: "ready",
      at: now,
      patch: { readyAt: now, lastActivityAt: now },
    });
    return ws.id;
  }

  function fakeAgent(
    server: TestServer,
    workspaceId: string,
    respond: (frame: { payload: { request_id: string; path: string } }) => void,
    protocolVersion: 4 | 5 = 5,
  ) {
    const sent: string[] = [];
    const ws = {
      send: (data: string) => {
        sent.push(data);
        const frame = JSON.parse(data) as {
          type: string;
          payload: { request_id: string; path: string };
        };
        if (frame.type === "proxy_request") queueMicrotask(() => respond(frame));
      },
      close: () => {},
    } as unknown as WSContext;
    const conn = server.hub.attach(workspaceId, randomUUID(), 1, ws, protocolVersion);
    conn.registered = true;
    return { conn, sent };
  }

  test("workspace not ready returns 409; terminal returns 410", async () => {
    const server = await createTestServer();
    const res = await server.app.request(
      "/v1/workspaces",
      authed(server.token, {
        method: "POST",
        headers: { "idempotency-key": "r1" },
        body: createTestBody(),
      }),
    );
    const ws = (await res.json()) as { id: string };
    const notReady = await server.app.request(
      `/v1/workspaces/${ws.id}/services/agent/status`,
      authed(server.token),
    );
    expect(notReady.status).toBe(409);

    await server.app.request(
      `/v1/workspaces/${ws.id}/cancel`,
      authed(server.token, { method: "POST" }),
    );
    const terminal = await server.app.request(
      `/v1/workspaces/${ws.id}/services/agent/status`,
      authed(server.token),
    );
    expect(terminal.status).toBe(410);
  });

  test("ready but disconnected returns 503", async () => {
    const server = await createTestServer();
    const id = await readyWorkspace(server);
    const res = await server.app.request(
      `/v1/workspaces/${id}/services/agent/status`,
      authed(server.token),
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "workspace.disconnected",
    );
  });

  test("undeclared routes and query fields are rejected with 422", async () => {
    const server = await createTestServer();
    const id = await readyWorkspace(server);
    fakeAgent(server, id, () => {});
    const badRoute = await server.app.request(
      `/v1/workspaces/${id}/services/agent/shell`,
      authed(server.token),
    );
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
    const server = await createTestServer();
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
    const server = await createTestServer();
    const id = await readyWorkspace(server);
    fakeAgent(server, id, (frame) => {
      server.hub.resolveRelay(server.hub.get(id) as never, {
        request_id: frame.payload.request_id,
        status: 200,
        headers: { "content-type": "application/json" },
        body_b64: Buffer.from(JSON.stringify({ status: "stable" })).toString("base64"),
      });
    });
    const res = await server.app.request(
      `/v1/workspaces/${id}/services/agent/status`,
      authed(server.token),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "stable" });
  });

  test("offers a direct AgentAPI alias without exposing the service abstraction", async () => {
    const server = await createTestServer();
    const id = await readyWorkspace(server);
    const { sent } = fakeAgent(server, id, (frame) => {
      server.hub.resolveRelay(server.hub.get(id) as never, {
        request_id: frame.payload.request_id,
        status: 200,
        headers: { "content-type": "application/json" },
        body_b64: Buffer.from(JSON.stringify({ status: "stable" })).toString("base64"),
      });
    });
    const res = await server.app.request(`/v1/workspaces/${id}/agent/status`, authed(server.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "stable" });
    expect(
      sent.map((value) => JSON.parse(value) as { payload: { service: string; path: string } }),
    ).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ service: "agent", path: "/status" }),
      }),
    );
  });

  test("streams a declared AgentAPI event response before upstream EOF", async () => {
    const server = await createTestServer();
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
    const server = await createTestServer();
    const id = await readyWorkspace(server);
    fakeAgent(server, id, () => {}, 4);
    const response = await server.app.request(
      `/v1/workspaces/${id}/agent/events`,
      authed(server.token),
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "relay.streaming_unsupported",
    );
  });
});
