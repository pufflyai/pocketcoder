import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecSpecSchema } from "@pstdio/pocketcoder-contracts";
import { runSetupSteps } from "./supervisor-setup";

test("workspace stop kills the active setup process before its normal timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc-setup-abort-"));
  const marker = join(root, "pid");
  const abort = new AbortController();
  const exec = ExecSpecSchema.parse({
    setup: [
      {
        name: "wait",
        command: [
          process.execPath,
          "-e",
          `await Bun.write(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`,
        ],
        env: {},
        timeoutSeconds: 2,
      },
    ],
    harness: { command: ["true"], env: {} },
    env: {},
    services: {},
    timeouts: { start: "1s", maxAge: "1h", idle: "1h", disconnectGrace: "1s", terminateGrace: "1s" },
    persistence: { mounts: [], conversation_restore: "filesystem_only" },
    checkpoint_hook: null,
    outputs: {},
  });
  const running = runSetupSteps(exec, {
    signal: abort.signal,
    send: () => true,
    log() {},
    setSetupPhase() {},
    async pump(stream) {
      await new Response(stream).text();
    },
  });
  let pid: number | null = null;
  try {
    const deadline = Date.now() + 1000;
    while (!(await Bun.file(marker).exists())) {
      if (Date.now() > deadline) throw new Error("Setup process did not start");
      await Bun.sleep(10);
    }
    pid = Number(await Bun.file(marker).text());
    abort.abort();
    expect(await Promise.race([running.then(() => true), Bun.sleep(150).then(() => false)])).toBe(true);
    expect(() => process.kill(pid as number, 0)).toThrow();
  } finally {
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    await running;
    await rm(root, { recursive: true, force: true });
  }
});
