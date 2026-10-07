// Exercises exact collision and target/deadline refusal on real private localhost transports.
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/config";
import { createTestServer } from "../testing/test-server.test";
import { startControllerListener } from "./controller-listener";
import { startProcessControl } from "./process-control";
import { readProcessCapability } from "./process-control-capability";
import { requestProcessQuiescence } from "./process-control-client";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ctl-"));
  const built = await createTestServer();
  const config = {
    ...loadConfig({ POCKETCODER_STORE: "memory", POCKETCODER_PEPPER: "synthetic-process-owner" }),
    listenHost: "127.0.0.1",
    listenPort: 0,
  };
  const running = startControllerListener(config, built, { store: built.store, timers: [] });
  const instanceId = crypto.randomUUID();
  const control = await startProcessControl({ running, root, instanceId });
  return {
    root,
    built,
    running,
    instanceId,
    control,
    async stop() {
      await control.stop();
      await running.stop();
      await rm(root, { recursive: true });
    },
  };
}

async function request(f: Awaited<ReturnType<typeof fixture>>, instanceId: string, deadlineUtcMs: number) {
  const target = await readProcessCapability(f.root, f.instanceId, process.pid);
  return fetch(`${target.url}/quiesce`, {
    headers: { authorization: target.authorization },
    method: "POST",
    body: JSON.stringify({ instanceId, pid: process.pid, deadlineUtcMs }),
    signal: AbortSignal.timeout(1000),
  });
}

test("existing control directory is refused without replacing its original evidence", async () => {
  const f = await fixture();
  try {
    const marker = join(f.control.capabilityPath, "..", "original.safe.txt");
    await writeFile(marker, "owned-original", { flag: "wx", mode: 0o600 });
    await expect(startProcessControl({ running: f.running, root: f.root, instanceId: f.instanceId })).rejects.toThrow();
    expect(await readFile(marker, "utf8")).toBe("owned-original");
    await rm(marker);
    expect(
      await requestProcessQuiescence({ root: f.root, instanceId: f.instanceId, pid: process.pid, timeoutSeconds: 1 }),
    ).toEqual({ instanceId: f.instanceId, pid: process.pid, outcome: "userspace_quiescent" });
  } finally {
    await f.stop();
  }
});

test("wrong instance and expired request cannot close current mutation admission", async () => {
  const f = await fixture();
  try {
    const target = await readProcessCapability(f.root, f.instanceId, process.pid);
    expect(
      (
        await fetch(`${target.url}/quiesce`, {
          method: "POST",
          headers: { authorization: target.authorization },
          body: JSON.stringify({ instanceId: f.instanceId, pid: process.pid + 1, deadlineUtcMs: Date.now() + 100 }),
        })
      ).status,
    ).toBe(409);
    expect((await request(f, crypto.randomUUID(), Date.now() + 100)).status).toBe(409);
    expect((await request(f, f.instanceId, Date.now() - 1)).status).toBe(409);
    expect((await fetch(`${f.running.url}/livez`)).status).toBe(200);
    expect((await request(f, f.instanceId, Date.now() + 500)).status).toBe(200);
    expect((await request(f, f.instanceId, Date.now() + 500)).status).toBe(409);
  } finally {
    await f.stop();
  }
});

test("symlink and configured workspace roots cannot host process-owner control", async () => {
  const f = await fixture();
  const alias = `${f.root}-alias`;
  try {
    await symlink(f.root, alias);
    await expect(
      startProcessControl({ running: f.running, root: alias, instanceId: crypto.randomUUID() }),
    ).rejects.toThrow("controller_control_root_unowned");
    f.running.config.workspaceDataDir = f.root;
    await expect(
      startProcessControl({ running: f.running, root: f.root, instanceId: crypto.randomUUID() }),
    ).rejects.toThrow("controller_control_root_exposed");
  } finally {
    await rm(alias);
    await f.stop();
  }
});

test("expired original held mutation refuses another control attempt and retains lease", async () => {
  const f = await fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = f.built.operations.run(() => held);
  let storeClosed = false;
  f.built.store.close = async () => {
    storeClosed = true;
  };
  try {
    expect((await request(f, f.instanceId, Date.now() + 20)).status).toBe(409);
    expect((await request(f, f.instanceId, Date.now() + 500)).status).toBe(409);
    expect(storeClosed).toBe(false);
  } finally {
    release();
    await pending;
    await f.stop();
  }
  expect(storeClosed).toBe(true);
});

test("caller loss cannot reset the admitted attempt or release its held store lease", async () => {
  const f = await fixture();
  let release!: () => void;
  const pending = f.built.operations.run(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  let entered!: () => void;
  const admitted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const originalQuiesce = f.running.quiesce.bind(f.running);
  f.running.quiesce = (signal) => {
    entered();
    return originalQuiesce(signal);
  };
  let storeClosed = false;
  f.built.store.close = async () => {
    storeClosed = true;
  };
  const caller = new AbortController();
  try {
    const target = await readProcessCapability(f.root, f.instanceId, process.pid);
    const original = fetch(`${target.url}/quiesce`, {
      method: "POST",
      headers: { authorization: target.authorization },
      body: JSON.stringify({ instanceId: f.instanceId, pid: process.pid, deadlineUtcMs: Date.now() + 500 }),
      signal: caller.signal,
    });
    await admitted;
    caller.abort();
    await expect(original).rejects.toThrow();
    expect((await request(f, f.instanceId, Date.now() + 500)).status).toBe(409);
    expect(storeClosed).toBe(false);
  } finally {
    release();
    await pending;
    await f.stop();
  }
  expect(storeClosed).toBe(true);
});
