import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { digestOpaque } from "@pstdio/pocketcoder-auth";
import { PROTOCOL_VERSION, type ServerFrame, ServerFrameSchema, snapshotServices } from "@pstdio/pocketcoder-contracts";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { FakeDriver } from "@pstdio/pocketcoder-testkit";
import { buildServer } from "../app";
import { createIssuerClient } from "../secrets/issuer-client";
import { leaseServiceFixture } from "../secrets/lease-service-fixture";

test("setup closure blocks readiness and cannot be reopened by an overlapping registration", async () => {
  const f = await leaseServiceFixture();
  const id = f.workspace.id;
  const snapshot = f.workspace.templateSnapshot;
  const registration = randomUUID();
  await f.store.updateWorkspace(
    id,
    { registrationDigest: digestOpaque(f.pepper, registration), registrationExpiresAt: f.workspace.deadlineAt },
    new Date(),
  );
  const built = buildServer({
    store: f.store,
    driver: new FakeDriver(),
    pepper: f.pepper,
    secretKey: f.encryptionKey.toString("base64url"),
    issuerClient: createIssuerClient({ ca: f.issuer.ca }),
    limits: DEFAULT_LIMITS,
    workspaceServerUrl: "http://127.0.0.1:1",
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: built.agentApp.fetch, websocket: built.websocket });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/v1/agent/connect`, {
    headers: {
      "x-pocketcoder-protocol": String(PROTOCOL_VERSION),
      "x-pocketcoder-workspace": id,
      "x-pocketcoder-registration": registration,
    },
  });
  const lateSocket = new WebSocket(`ws://127.0.0.1:${server.port}/v1/agent/connect`, {
    headers: {
      "x-pocketcoder-protocol": String(PROTOCOL_VERSION),
      "x-pocketcoder-workspace": id,
      "x-pocketcoder-registration": registration,
    },
  });
  const lateOpen = new Promise<void>((resolve, reject) => {
    lateSocket.onopen = () => resolve();
    lateSocket.onerror = reject;
  });
  const lateClosed = Promise.withResolvers<void>();
  lateSocket.onclose = () => lateClosed.resolve();
  const frames: ServerFrame[] = [];
  socket.onmessage = (event) => frames.push(ServerFrameSchema.parse(JSON.parse(String(event.data))));
  const connectionId = randomUUID();
  let sequence = 0;
  function send(type: string, payload: unknown) {
    socket.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        workspace_id: id,
        connection_id: connectionId,
        seq: sequence++,
        sent_at: new Date().toISOString(),
        type,
        payload,
      }),
    );
  }
  async function next<T extends ServerFrame["type"]>(type: T) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const index = frames.findIndex((frame) => frame.type === type);
      if (index >= 0) return frames.splice(index, 1)[0] as Extract<ServerFrame, { type: T }>;
      await Bun.sleep(10);
    }
    throw new Error(`Missing controller frame ${type}`);
  }
  try {
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = reject;
    });
    await lateOpen;
    send("registered", {
      agent_version: "fixture",
      template: { name: snapshot.name, version: snapshot.version, digest: snapshot.digest },
      services: [],
      pid: process.pid,
    });
    const registered = await next("registered_ack");
    const setup = registered.payload.exec.source;
    if (!setup?.credential) throw new Error("Missing setup authority");
    for (const service of Object.keys(snapshotServices(snapshot)))
      send("service_health", { service, health: "healthy" });
    send("source_resolved", { repository: "app", requested_revision: "main", resolved_commit: "a".repeat(40) });
    send("process_state", { phase: "running" });
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const current = await f.store.getWorkspace(id);
      if (current && Object.keys(snapshotServices(snapshot)).every((service) => current.health[service] === "healthy"))
        break;
      await Bun.sleep(10);
    }
    expect(await f.issuer.resource(setup.credential, id)).toBe(200);
    expect((await f.store.getWorkspace(id))?.state).toBe("connected");
    send("setup_complete", { request_id: randomUUID() });
    await next("setup_complete_ack");
    expect(await f.issuer.resource(setup.credential, id)).toBe(401);
    lateSocket.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        workspace_id: id,
        connection_id: randomUUID(),
        seq: 0,
        sent_at: new Date().toISOString(),
        type: "registered",
        payload: {
          agent_version: "fixture",
          template: { name: snapshot.name, version: snapshot.version, digest: snapshot.digest },
          services: [],
          pid: process.pid,
        },
      }),
    );
    await lateClosed.promise;
    expect(await f.issuer.resource(f.issuer.controls.captured, id)).toBe(401);
    expect(await f.store.listPendingWorkspaceLeases(id)).toEqual([]);
    expect(await f.store.listWorkspaceLeases(id)).toHaveLength(1);
    send("process_state", { phase: "running" });
    await Bun.sleep(50);
    expect((await f.store.getWorkspace(id))?.state).toBe("ready");
  } finally {
    socket.close();
    lateSocket.close();
    await server.stop(true);
    await f.close();
  }
});
