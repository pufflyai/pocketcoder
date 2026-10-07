// Proves actual bound localhost transport is settled when postbind private-file preparation fails.
import { expect, spyOn, test } from "bun:test";
import * as files from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/config";
import { createTestServer } from "../testing/test-server.test";
import { startControllerListener } from "./controller-listener";
import { startProcessControl } from "./process-control";

test("postbind file publication failure closes the actual private localhost listener", async () => {
  const root = await files.mkdtemp(join(tmpdir(), "ctl-"));
  const instanceId = crypto.randomUUID();
  const built = await createTestServer();
  const config = {
    ...loadConfig({ POCKETCODER_STORE: "memory", POCKETCODER_PEPPER: "synthetic-process-owner" }),
    listenHost: "127.0.0.1",
    listenPort: 0,
  };
  const running = startControllerListener(config, built, { store: built.store, timers: [] });
  const originalServe = Bun.serve.bind(Bun);
  let transport: ReturnType<typeof Bun.serve> | undefined;
  const observing = spyOn(Bun, "serve").mockImplementation((options) => {
    const server = originalServe(options);
    transport = server;
    return server;
  });
  const publication = spyOn(files, "open").mockRejectedValue(new Error("synthetic_private_file_failure"));
  try {
    await expect(startProcessControl({ running, root, instanceId })).rejects.toThrow("synthetic_private_file_failure");
    await expect(
      fetch(`${transport?.url}quiesce`, { method: "POST", signal: AbortSignal.timeout(500) }),
    ).rejects.toThrow();
  } finally {
    observing.mockRestore();
    publication.mockRestore();
    await transport?.stop(true);
    await running.stop();
    await files.rm(root, { recursive: true });
  }
});
