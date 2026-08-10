import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { WSContext } from "hono/ws";
import { authed, createTestServer, type TestServer } from "./test-server.test";

function connectTerminalAgent(server: TestServer, workspaceId: string, protocolVersion: 3 | 4) {
  const connection = server.hub.attach(
    workspaceId,
    randomUUID(),
    1,
    { send() {}, close() {} } as unknown as WSContext,
    protocolVersion,
  );
  connection.registered = true;
}

async function terminalWorkspace(
  server: TestServer,
  template: "fixture-echo" | "fixture-terminal",
) {
  const response = await server.app.request(
    "/v1/workspaces",
    authed(server.token, {
      method: "POST",
      headers: { "idempotency-key": randomUUID() },
      body: JSON.stringify({
        external_id: randomUUID(),
        template: { name: template },
      }),
    }),
  );
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string };
}

async function readyTerminalWorkspace(
  server: TestServer,
  template: "fixture-echo" | "fixture-terminal",
) {
  const created = await terminalWorkspace(server, template);
  await server.scheduler.tick();
  const now = new Date();
  await server.store.transition(created.id, {
    from: ["provisioning"],
    to: "connected",
    at: now,
  });
  await server.store.transition(created.id, {
    from: ["connected"],
    to: "ready",
    at: now,
    patch: { readyAt: now, lastActivityAt: now },
  });
  return created.id;
}

describe("remote terminals", () => {
  test("holds scope, workspace-state, template, and protocol gates before upgrade", async () => {
    const server = await createTestServer();
    const pending = await terminalWorkspace(server, "fixture-terminal");
    const notReady = await server.app.request(
      `/v1/workspaces/${pending.id}/terminal`,
      authed(server.token),
    );
    expect(notReady.status).toBe(409);

    const withoutTerminal = await readyTerminalWorkspace(server, "fixture-echo");
    connectTerminalAgent(server, withoutTerminal, 4);
    const undeclared = await server.app.request(
      `/v1/workspaces/${withoutTerminal}/terminal`,
      authed(server.token),
    );
    expect(undeclared.status).toBe(422);
    expect(((await undeclared.json()) as { error: { code: string } }).error.code).toBe(
      "terminal.not_declared",
    );

    const oldProtocol = await readyTerminalWorkspace(server, "fixture-terminal");
    connectTerminalAgent(server, oldProtocol, 3);
    const unsupported = await server.app.request(
      `/v1/workspaces/${oldProtocol}/terminal`,
      authed(server.token),
    );
    expect(unsupported.status).toBe(426);

    const missingScope = await server.app.request(
      `/v1/workspaces/${oldProtocol}/terminal`,
      authed(server.limitedToken),
    );
    expect(missingScope.status).toBe(403);
  });

  test("returns principal-owned terminal session audit pages", async () => {
    const server = await createTestServer();
    const workspaceId = await readyTerminalWorkspace(server, "fixture-terminal");
    const openedAt = new Date("2026-08-05T12:00:00.000Z");
    const session = await server.store.openTerminalSession(
      { sessionId: randomUUID(), workspaceId, keyId: server.keyId, openedAt },
      2,
    );
    if (!session) throw new Error("expected terminal session");
    await server.store.closeTerminalSession(session.sessionId, {
      closedAt: new Date("2026-08-05T12:01:00.000Z"),
      closeReason: "exit",
      exitCode: 0,
      bytesIn: 5,
      bytesOut: 9,
    });

    const response = await server.app.request(
      `/v1/workspaces/${workspaceId}/terminal-sessions`,
      authed(server.token),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      items: [
        {
          session_id: session.sessionId,
          close_reason: "exit",
          exit_code: 0,
          duration_ms: 60_000,
          bytes_in: 5,
          bytes_out: 9,
        },
      ],
      next_cursor: null,
    });
  });

  test("rejects malformed reattach ids and enforces the audited session limit", async () => {
    const server = await createTestServer();
    const workspaceId = await readyTerminalWorkspace(server, "fixture-terminal");
    connectTerminalAgent(server, workspaceId, 4);
    const upgrade = { upgrade: "websocket" };
    const malformed = await server.app.request(
      `/v1/workspaces/${workspaceId}/terminal?session=not-a-uuid`,
      authed(server.token, { headers: upgrade }),
    );
    expect(malformed.status).toBe(400);

    for (let index = 0; index < 2; index += 1) {
      expect(
        await server.store.openTerminalSession(
          {
            sessionId: randomUUID(),
            workspaceId,
            keyId: server.keyId,
            openedAt: new Date(),
          },
          2,
        ),
      ).not.toBeNull();
    }
    const limited = await server.app.request(
      `/v1/workspaces/${workspaceId}/terminal`,
      authed(server.token, { headers: upgrade }),
    );
    expect(limited.status).toBe(409);
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe(
      "terminal.session_limit",
    );
  });

  test("upgrades a terminal WebSocket and audits the live session", async () => {
    const server = await createTestServer();
    const workspaceId = await readyTerminalWorkspace(server, "fixture-terminal");
    let connection: ReturnType<TestServer["hub"]["attach"]>;
    const agentSocket = {
      send(value: string) {
        const frame = JSON.parse(value) as {
          type: string;
          payload: { session_id?: string; data_b64?: string };
        };
        if (!frame.payload.session_id) return;
        const sessionId = frame.payload.session_id;
        if (frame.type === "terminal_open") {
          queueMicrotask(() => server.hub.terminalOpened(connection, { session_id: sessionId }));
          return;
        }
        if (frame.type !== "terminal_input" || !frame.payload.data_b64) return;
        queueMicrotask(() => {
          server.hub.terminalOutput(connection, {
            session_id: sessionId,
            data_b64: frame.payload.data_b64 as string,
          });
          server.hub.terminalClosed(connection, {
            session_id: sessionId,
            reason: "exit",
            exit_code: 3,
          });
        });
      },
      close() {},
    } as unknown as WSContext;
    connection = server.hub.attach(workspaceId, randomUUID(), 1, agentSocket, 4);
    connection.registered = true;
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: server.app.fetch,
      websocket: server.websocket,
    });
    try {
      const frames: Array<Record<string, unknown>> = [];
      const socket = new WebSocket(
        `ws://127.0.0.1:${listener.port}/v1/workspaces/${workspaceId}/terminal`,
        { headers: { authorization: `Bearer ${server.token}` } } as unknown as string[],
      );
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("terminal WebSocket timed out")), 2000);
        socket.onerror = () => reject(new Error("terminal WebSocket failed"));
        socket.onclose = (event) =>
          reject(new Error(`terminal WebSocket closed (${event.code}): ${event.reason}`));
        socket.onmessage = (event) => {
          const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
          frames.push(frame);
          if (frame.type === "opened") {
            socket.send(
              JSON.stringify({
                type: "input",
                data_b64: Buffer.from("live-terminal").toString("base64"),
              }),
            );
          }
          if (frame.type !== "closed") return;
          clearTimeout(timeout);
          socket.onclose = null;
          socket.close();
          resolve();
        };
      });
      expect(frames).toEqual([
        expect.objectContaining({ type: "opened" }),
        { type: "output", data_b64: Buffer.from("live-terminal").toString("base64") },
        expect.objectContaining({ type: "closed", reason: "exit", exit_code: 3 }),
      ]);
      const sessionId = String(frames[0]?.session_id);
      const deadline = Date.now() + 1000;
      while (!(await server.store.getTerminalSession(sessionId))?.closedAt) {
        if (Date.now() > deadline) throw new Error("terminal audit did not close");
        await Bun.sleep(2);
      }
      expect(await server.store.getTerminalSession(sessionId)).toMatchObject({
        workspaceId,
        closeReason: "exit",
        exitCode: 3,
        bytesIn: 13,
        bytesOut: 13,
      });
      const eventTypes = (await server.store.claimDueEvents(new Date(Date.now() + 1000), 100)).map(
        (event) => event.eventType,
      );
      expect(eventTypes).toEqual(
        expect.arrayContaining(["workspace.terminal_opened", "workspace.terminal_closed"]),
      );
    } finally {
      await listener.stop(true);
    }
  }, 5000);
});
