// Exercises the production listener composition with real local HTTP and memory-store ownership.
import { expect, test } from "bun:test";
import { loadConfig } from "../config/config";
import { authed, createTestServer } from "../testing/test-server.test";
import { startControllerListener } from "./controller-listener";

function config() {
  return {
    ...loadConfig({ POCKETCODER_STORE: "memory", POCKETCODER_PEPPER: "synthetic-maintenance-pepper" }),
    listenHost: "127.0.0.1",
    listenPort: 0,
  };
}

test("public quiesce closes real admission while retaining coordinator store", async () => {
  const built = await createTestServer();
  let storeClosed = false;
  const original = built.store.close.bind(built.store);
  built.store.close = async () => {
    storeClosed = true;
    await original();
  };
  const running = startControllerListener(config(), built, { store: built.store, timers: [] });
  try {
    expect((await fetch(`${running.url}/v1/templates`, authed(built.token))).status).toBe(200);
    await running.quiesce(AbortSignal.timeout(500));
    expect(storeClosed).toBe(false);
    await expect(fetch(`${running.url}/livez`)).rejects.toThrow();
    expect((await built.app.request("/v1/templates", authed(built.token))).status).toBe(409);
  } finally {
    await running.stop();
  }
  expect(storeClosed).toBe(true);
});

test("expired quiesce cannot release store or reset an unknown original join", async () => {
  const built = await createTestServer();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const originalWrite = built.store.touchMachineKey.bind(built.store);
  built.store.touchMachineKey = async (...args) => {
    entered();
    await held;
    await originalWrite(...args);
  };
  let storeClosed = false;
  built.store.close = async () => {
    storeClosed = true;
  };
  const running = startControllerListener(config(), built, { store: built.store, timers: [] });
  let stopping: Promise<void> | undefined;
  try {
    expect((await fetch(`${running.url}/v1/templates`, authed(built.token))).status).toBe(200);
    await started;
    const quiescing = running.quiesce(AbortSignal.timeout(20));
    await expect(quiescing).rejects.toThrow();
    expect(storeClosed).toBe(false);
    expect(running.quiesce(AbortSignal.timeout(500))).toBe(quiescing);
    stopping = running.stop();
    await Bun.sleep(5);
    expect(storeClosed).toBe(false);
  } finally {
    release();
    await (stopping ?? running.stop());
  }
  expect(storeClosed).toBe(true);
});

test("settled original controller failure refuses quiesce and lease release", async () => {
  const built = await createTestServer();
  const originalFailure = new Error("physical_write_failed");
  await expect(
    built.operations.run(async () => {
      throw originalFailure;
    }),
  ).rejects.toBe(originalFailure);
  let storeClosed = false;
  built.store.close = async () => {
    storeClosed = true;
  };
  const running = startControllerListener(config(), built, { store: built.store, timers: [] });
  await expect(running.quiesce(AbortSignal.timeout(500))).rejects.toThrow("controller_tasks_unsettled");
  await expect(running.stop()).rejects.toThrow("controller_tasks_unsettled");
  expect(storeClosed).toBe(false);
});

test("a mutation cannot quiesce and join its own public controller scope", async () => {
  const built = await createTestServer();
  const running = startControllerListener(config(), built, { store: built.store, timers: [] });
  try {
    await built.operations.run(async () => {
      expect(() => running.quiesce(AbortSignal.timeout(500))).toThrow("controller_control_reentrancy");
    });
    expect((await fetch(`${running.url}/v1/templates`, authed(built.token))).status).toBe(200);
    await running.quiesce(AbortSignal.timeout(500));
  } finally {
    await running.stop();
  }
});
