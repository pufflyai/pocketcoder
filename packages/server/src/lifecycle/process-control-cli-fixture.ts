// Runs a finite synthetic real listener for the owning CLI transport behavior test.
import { loadConfig } from "../config/config";
import { createTestServer } from "../testing/test-server.test";
import { startControllerListener } from "./controller-listener";
import { startProcessControl } from "./process-control";

export const processControlCliFixtureSource = import.meta.path;

async function runFixture() {
  const instanceId = process.argv[2] as string;
  const root = process.argv[3] as string;
  const built = await createTestServer();
  const config = {
    ...loadConfig({ POCKETCODER_STORE: "memory", POCKETCODER_PEPPER: "synthetic-process-owner" }),
    listenHost: "127.0.0.1",
    listenPort: 0,
  };
  const running = startControllerListener(config, built, { store: built.store, timers: [] });
  const control = await startProcessControl({ running, root, instanceId });
  console.log(JSON.stringify({ pid: process.pid, instanceId, url: running.url }));
  await new Promise<void>((resolve, reject) => {
    let stopping = false;
    const finish = (expired: boolean) => {
      if (stopping) return;
      stopping = true;
      clearTimeout(timer);
      void control
        .stop()
        .then(() => running.stop())
        .then(() => {
          if (expired) reject(new Error("synthetic_controller_fixture_expired"));
          else resolve();
        }, reject);
    };
    const timer = setTimeout(() => finish(true), 10_000);
    process.once("SIGTERM", () => finish(false));
  });
}

if (import.meta.main) await runFixture();
