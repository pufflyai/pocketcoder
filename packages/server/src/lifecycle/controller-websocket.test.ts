// Exercises actual agent transport lifetime through the real HTTP upgrade path.
import { expect, test } from "bun:test";
import {
  HEADER_PROTOCOL,
  HEADER_REGISTRATION,
  HEADER_WORKSPACE,
  PROTOCOL_VERSION,
} from "@pstdio/pocketcoder-contracts";
import { authed, createTestBody, createTestServer } from "../testing/test-server.test";

test("admitted agent transport remains owned until its exact close", async () => {
  const controller = await createTestServer();
  const response = await controller.app.request(
    "/v1/workspaces",
    authed(controller.token, {
      method: "POST",
      headers: { "idempotency-key": "transport-owner" },
      body: createTestBody(),
    }),
  );
  expect(response.status).toBe(201);
  const { id } = (await response.json()) as { id: string };
  await controller.scheduler.tick();
  const input = controller.driver.inputFor(id);
  if (!input) throw new Error("missing synthetic provider input");
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: controller.app.fetch,
    websocket: controller.websocket,
  });
  const socket = new WebSocket(`ws://127.0.0.1:${listener.port}/v1/agent/connect`, {
    headers: {
      [HEADER_PROTOCOL]: String(PROTOCOL_VERSION),
      [HEADER_WORKSPACE]: id,
      [HEADER_REGISTRATION]: input.registration_secret,
    },
  } as unknown as string[]);
  let closing: Promise<void> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("synthetic_upgrade_failed"));
    });
    let closed = false;
    closing = controller.operations.close().then(() => {
      closed = true;
    });
    await Bun.sleep(5);
    expect(closed).toBe(false);
  } finally {
    socket.close();
    await listener.stop(true);
    await closing;
  }
});

test("transport close joins a queued registration and its disconnect write", async () => {
  const controller = await createTestServer();
  const response = await controller.app.request(
    "/v1/workspaces",
    authed(controller.token, {
      method: "POST",
      headers: { "idempotency-key": "queued-transport-owner" },
      body: createTestBody(),
    }),
  );
  const { id } = (await response.json()) as { id: string };
  await controller.scheduler.tick();
  const input = controller.driver.inputFor(id);
  if (!input) throw new Error("missing synthetic provider input");
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transition = controller.store.transition.bind(controller.store);
  controller.store.transition = async (...args) => {
    if (args[1].to === "connected") {
      entered();
      await held;
    }
    return transition(...args);
  };
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: controller.app.fetch,
    websocket: controller.websocket,
  });
  const socket = new WebSocket(`ws://127.0.0.1:${listener.port}/v1/agent/connect`, {
    headers: {
      [HEADER_PROTOCOL]: String(PROTOCOL_VERSION),
      [HEADER_WORKSPACE]: id,
      [HEADER_REGISTRATION]: input.registration_secret,
    },
  } as unknown as string[]);
  let closing: Promise<void> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("synthetic_upgrade_failed"));
    });
    socket.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: "registered",
        workspace_id: id,
        connection_id: crypto.randomUUID(),
        seq: 0,
        sent_at: new Date().toISOString(),
        payload: {
          agent_version: "synthetic",
          template: { name: input.template_name, version: input.template_version, digest: input.template_digest },
          services: ["agent"],
          pid: 1,
        },
      }),
    );
    await started;
    socket.close();
    let settled = false;
    closing = controller.operations.close().then(() => {
      settled = true;
    });
    await listener.stop(true);
    await Bun.sleep(5);
    expect(settled).toBe(false);
    release();
    await closing;
    expect((await controller.store.getWorkspace(id))?.disconnectedAt).toBeInstanceOf(Date);
    expect(controller.hub.get(id)).toBeUndefined();
  } finally {
    release();
    socket.close();
    await listener.stop(true);
    await closing;
  }
});
