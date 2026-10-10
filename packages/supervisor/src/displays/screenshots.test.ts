import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ExecSpecSchema } from "@pstdio/pocketcoder-contracts";
import { SupervisorScreenshots } from "./screenshots";

test("supervisor capture expiry cancels browser setup before the connection timeout", async () => {
  const discovery = Bun.serve({ hostname: "127.0.0.1", port: 9222, fetch: () => new Promise<Response>(() => {}) });
  const exec = ExecSpecSchema.parse({
    setup: [],
    harness: { command: ["unused"], env: {} },
    env: {},
    services: {},
    timeouts: { start: "2s", maxAge: "1h", idle: "1h", disconnectGrace: "2s", terminateGrace: "2s" },
    persistence: { mounts: [], conversation_restore: "filesystem_only" },
    checkpoint_hook: null,
    outputs: {},
    display: { mode: "browser" },
  });
  const screenshots = new SupervisorScreenshots("http://127.0.0.1:8999", () => exec);
  try {
    const id = randomUUID();
    const started = performance.now();
    await expect(
      screenshots.capture({
        output_id: id,
        credential: "x".repeat(43),
        expires_at: new Date(Date.now() + 50).toISOString(),
        url: `http://127.0.0.1:8999/v1/agent/screenshots/${id}`,
      }),
    ).rejects.toThrow();
    await screenshots.cancel();
    expect(performance.now() - started).toBeLessThan(1000);
  } finally {
    await screenshots.cancel();
    await discovery.stop(true);
  }
});
