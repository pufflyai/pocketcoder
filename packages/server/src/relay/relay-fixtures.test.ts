import { randomUUID } from "node:crypto";
import type { WSContext } from "hono/ws";
import { authed, createTestBody, type TestServer } from "../testing/test-server.test";

export interface RelayFrame {
  payload: { request_id: string; method: string; path: string; body_b64?: string };
}

export async function readyWorkspace(server: TestServer) {
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

// Stands in for the supervisor's control-channel socket; `respond` answers
// each relayed request.
export function fakeAgent(
  server: TestServer,
  workspaceId: string,
  respond: (frame: RelayFrame) => void,
  protocolVersion: 4 | 5 = 5,
) {
  const sent: string[] = [];
  const ws = {
    send: (data: string) => {
      sent.push(data);
      const frame = JSON.parse(data) as RelayFrame & { type: string };
      if (frame.type === "proxy_request") queueMicrotask(() => respond(frame));
    },
    close: () => {},
  } as unknown as WSContext;
  const conn = server.hub.attach(workspaceId, randomUUID(), 1, ws, protocolVersion);
  conn.registered = true;
  return { conn, sent };
}

export function respondJson(server: TestServer, workspaceId: string, frame: RelayFrame, body: unknown) {
  server.hub.resolveRelay(server.hub.get(workspaceId) as never, {
    request_id: frame.payload.request_id,
    status: 200,
    headers: { "content-type": "application/json" },
    body_b64: Buffer.from(JSON.stringify(body)).toString("base64"),
  });
}
