// Joins the real scheduler's detached provider finalization through all remaining awaits.
import { expect, test } from "bun:test";
import { DEFAULT_LIMITS, Scheduler } from "@pstdio/pocketcoder-runtime-core";
import { loadConfig } from "../config/config";
import { authed, createTestBody, createTestServer } from "../testing/test-server.test";
import { startControllerListener } from "./controller-listener";

test("closed admission owns the complete detached provider termination", async () => {
  const server = await createTestServer();
  const response = await server.app.request(
    "/v1/workspaces",
    authed(server.token, {
      method: "POST",
      headers: { "idempotency-key": "termination-owner" },
      body: createTestBody(),
    }),
  );
  const { id } = (await response.json()) as { id: string };
  await server.scheduler.tick();
  const row = await server.store.getWorkspace(id);
  if (!row?.providerRef) throw new Error("expected actual synthetic allocation");
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stop = server.driver.stop.bind(server.driver);
  server.driver.stop = async (...args) => {
    entered();
    await held;
    await stop(...args);
  };
  let removed = false;
  const remove = server.driver.remove.bind(server.driver);
  server.driver.remove = async (...args) => {
    await remove(...args);
    removed = true;
  };
  await server.scheduler.beginTermination(row, "canceled", "canceled_by_caller", new Date());
  await started;
  const configuration = {
    ...loadConfig({ POCKETCODER_STORE: "memory", POCKETCODER_PEPPER: "synthetic-controller" }),
    listenHost: "127.0.0.1",
    listenPort: 0,
  };
  const running = startControllerListener(configuration, server, { store: server.store, timers: [] });
  const closing = running.quiesce(AbortSignal.timeout(500));
  const observed = closing.then(
    () => null,
    (error) => error,
  );
  release();
  try {
    const failure = await observed;
    expect(failure).toBeNull();
    expect(removed).toBe(true);
    expect((await server.store.getWorkspace(id))?.state).toBe("canceled");
  } finally {
    await running.stop();
  }
});

test("standalone scheduler close joins its own detached finalization owner", async () => {
  const server = await createTestServer();
  const response = await server.app.request(
    "/v1/workspaces",
    authed(server.token, {
      method: "POST",
      headers: { "idempotency-key": "standalone-termination" },
      body: createTestBody(),
    }),
  );
  const { id } = (await response.json()) as { id: string };
  await server.scheduler.tick();
  const row = await server.store.getWorkspace(id);
  if (!row?.providerRef) throw new Error("expected actual synthetic allocation");
  const scheduler = new Scheduler({
    store: server.store,
    driver: server.driver,
    connections: server.hub,
    limits: DEFAULT_LIMITS,
    secrets: { generate: () => "synthetic-only-secret", digest: (value) => new TextEncoder().encode(value) },
    workspaceServerUrl: "http://127.0.0.1:0",
  });
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stop = server.driver.stop.bind(server.driver);
  server.driver.stop = async (...args) => {
    entered();
    await held;
    await stop(...args);
  };
  await scheduler.beginTermination(row, "canceled", "canceled_by_caller", new Date());
  await started;
  let drained = false;
  const draining = scheduler.close().then(() => {
    drained = true;
  });
  try {
    await Bun.sleep(5);
    expect(drained).toBe(false);
  } finally {
    release();
    await draining;
  }
  expect((await server.store.getWorkspace(id))?.state).toBe("canceled");
});
