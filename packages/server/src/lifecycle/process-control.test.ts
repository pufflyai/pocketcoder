// Exercises actual process-private localhost control responses after mutation listener closure.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/config";
import { authed, createTestServer } from "../testing/test-server.test";
import { startControllerListener } from "./controller-listener";
import { startProcessControl } from "./process-control";
import { requestProcessQuiescence } from "./process-control-client";

test("owning process control retains quiesce response after mutation transport closes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctl-"));
  const built = await createTestServer();
  let storeClosed = false;
  built.store.close = async () => {
    storeClosed = true;
  };
  const config = {
    ...loadConfig({ POCKETCODER_STORE: "memory", POCKETCODER_PEPPER: "synthetic-process-owner" }),
    listenHost: "127.0.0.1",
    listenPort: 0,
  };
  const running = startControllerListener(config, built, { store: built.store, timers: [] });
  const instanceId = crypto.randomUUID();
  let control: Awaited<ReturnType<typeof startProcessControl>> | undefined;
  try {
    expect((await fetch(`${running.url}/v1/templates`, authed(built.token))).status).toBe(200);
    control = await startProcessControl({ running, root, instanceId });
    expect(await requestProcessQuiescence({ root, instanceId, pid: process.pid, timeoutSeconds: 1 })).toEqual({
      instanceId,
      pid: process.pid,
      outcome: "userspace_quiescent",
    });
    expect(storeClosed).toBe(false);
    await expect(fetch(`${running.url}/livez`)).rejects.toThrow();
  } finally {
    await control?.stop();
    await running.stop();
    await rm(root, { recursive: true });
  }
  expect(storeClosed).toBe(true);
});
