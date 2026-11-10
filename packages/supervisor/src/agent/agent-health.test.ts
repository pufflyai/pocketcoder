import { expect, test } from "bun:test";
import { ExecSpecSchema } from "@pstdio/pocketcoder-contracts";
import { AgentHealthMonitor } from "./agent-health";

test("service readiness follows HTTP health without a terminal transcript", async () => {
  let healthy = true;
  const server = Bun.serve({ port: 0, fetch: () => new Response("", { status: healthy ? 200 : 503 }) });
  const frames: { type: string; payload: unknown }[] = [];
  const exec = ExecSpecSchema.parse({
    setup: [],
    harness: { command: ["echo"], env: {} },
    env: {},
    services: {
      session: {
        baseUrl: server.url.toString(),
        healthPath: "/healthz",
        routes: [{ method: "GET", path: "/healthz" }],
      },
    },
    timeouts: {},
    persistence: { mounts: [], conversation_restore: "unknown" },
    checkpoint_hook: null,
    outputs: {},
    launch_mode: "create",
    source: null,
    restore: null,
    network: { mode: "unrestricted" },
  });
  const monitor = new AgentHealthMonitor({
    exec: () => exec,
    childPhase: () => "running",
    send: (type, payload) => {
      frames.push({ type, payload });
      return true;
    },
    log: () => {},
  });
  try {
    await monitor.probeService(exec, "session", true);
    healthy = false;
    await monitor.probeService(exec, "session", false);
    expect(frames).toEqual([
      { type: "service_health", payload: { service: "session", health: "healthy" } },
      { type: "service_health", payload: { service: "session", health: "unhealthy" } },
    ]);
  } finally {
    await server.stop(true);
  }
});
