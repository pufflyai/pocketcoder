import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { DockerDriver } from "@pstdio/pocketcoder-drivers";
import { DEFAULT_LIMITS, Scheduler } from "@pstdio/pocketcoder-runtime-core";
import { dockerExecutionFixture, executionDockerImage } from "./execution-docker-fixture.test";

const available =
  Bun.spawnSync(["docker", "image", "inspect", executionDockerImage], { stdout: "ignore", stderr: "ignore" })
    .exitCode === 0;
async function docker(...args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(error);
  return output.trim();
}

test.skipIf(!available).each(["crash", "deadline", "cancel-owned", "restart"])(
  "Docker runtime records exact lifecycle ownership after %s",
  async (ending) => {
    const f = await dockerExecutionFixture(["bun", "-e", "setInterval(()=>{},1000)"]);
    let now = new Date();
    const scheduler = new Scheduler({
      now: () => now,
      store: f.store,
      driver: f.driver,
      connections: f.hub,
      limits: DEFAULT_LIMITS,
      secrets: { generate: () => randomUUID(), digest: (s) => new TextEncoder().encode(s) },
      workspaceServerUrl: "http://localhost",
    });
    try {
      const a = await f.prepare(false);
      const id = a.workspace.id;
      const incarnation = a.acceptance.execution.incarnationId;
      const unavailableDriver = new DockerDriver({ dockerBin: "/unavailable-docker" });
      await expect(unavailableDriver.inspect(a.ref)).rejects.toThrow();
      expect((await f.store.getWorkspace(id))?.finiteProcess).toBeNull();
      now = new Date(Date.now() + 2000);
      await scheduler.sweep();
      expect((await f.store.getWorkspace(id))?.state).toBe("ready");
      await f.store.executions.accept(a.acceptance, new Date());
      await f.executionDispatcher.tick();
      await f.waitFor(async () => (await f.store.getWorkspace(id))?.finiteProcess?.phase === "running");
      if (ending === "cancel-owned")
        await f.store.transition(id, {
          from: ["ready"],
          to: "terminating",
          reason: "canceled_by_caller",
          at: new Date(),
          patch: { terminalIntent: "canceled" },
        });
      if (ending === "restart") {
        const epoch = f.hub.get(id)?.epoch ?? 0;
        await docker("restart", "--signal=KILL", a.ref.id);
        await f.waitFor(async () => (f.hub.get(id)?.epoch ?? 0) > epoch);
        expect((await f.driver.inspect(a.ref)).containerIdentity).not.toBe(incarnation);
        expect(await docker("inspect", "--format", "{{.Id}} {{.RestartCount}}", a.ref.id)).toBe(`${a.ref.id} 0`);
      } else if (ending !== "deadline") await docker("kill", "--signal=KILL", a.ref.id);
      else now = new Date(Date.now() + 600001);
      await scheduler.sweep();
      await scheduler.drain();
      if (ending === "cancel-owned") {
        const current = await f.store.getWorkspace(id);
        expect(current?.state).toBe("terminating");
        if (!current) throw new Error("Workspace missing");
        await scheduler.finalize(current, "canceled", "canceled_by_caller", new Date());
        expect((await f.store.getWorkspace(id))?.state).toBe("canceled");
      }
      if (ending === "deadline") expect((await f.store.getWorkspace(id))?.state).toBe("expired");
      expect((await f.store.getWorkspace(id))?.finiteProcess).toMatchObject({
        execution: a.acceptance.execution,
        phase: ending === "deadline" ? "exited" : "lost",
        exitCode: null,
        signal: ending === "deadline" ? "SIGTERM" : null,
      });
      expect((await f.store.getWorkspace(id))?.runtimeRegistration?.endedAt).toBeString();
      expect((await f.store.getWorkspace(id))?.runtimeRegistration?.incarnationId).toBe(incarnation);
    } finally {
      await f.dispose();
    }
  },
  15000,
);
