import { expect, test } from "bun:test";
import { ExecSpecSchema } from "@pstdio/pocketcoder-contracts";
import { AgentHealthMonitor } from "../agent/agent-health";
import { prepareCheckpoint } from "./checkpoint-coordinator";

test.each([false, true])("checkpoint history starts a fresh read (older read hangs: %s)", async (hang) => {
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  let reads = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/status") {
        if (!hang) setTimeout(release, 20);
        return Response.json({ status: "stable" });
      }
      const content = ++reads === 1 ? "partial" : "completed";
      if (reads === 1) {
        started();
        await held;
      }
      return Response.json({
        messages: [
          { id: 1, role: "user", content: "accepted", time: "2026-10-05T12:00:00Z" },
          { id: 2, role: "agent", content, time: "2026-10-05T12:00:01Z" },
        ],
      });
    },
  });
  const exec = ExecSpecSchema.parse({
    agentapi_native: true,
    setup: [],
    harness: { command: ["unused"], env: {} },
    env: {},
    services: {
      agent: {
        baseUrl: server.url.toString(),
        healthPath: "/status",
        required: true,
        routes: [{ method: "GET", path: "/messages" }],
      },
    },
    timeouts: { start: "2s", maxAge: "1h", idle: "1h", disconnectGrace: "2s", terminateGrace: "2s" },
    persistence: { mounts: [], conversation_restore: "filesystem_only" },
    checkpoint_hook: null,
    outputs: {},
  });
  const contents: string[] = [];
  const phases: string[] = [];
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  let exited = false;
  void child.exited.then(() => {
    exited = true;
  });
  const monitor = new AgentHealthMonitor({
    exec: () => exec,
    childPhase: () => "running",
    send(type, payload) {
      if (type === "conversation_message") contents.push((payload as { content: string }).content);
      return true;
    },
    log: () => {},
  });
  monitor.setAgentState("running");
  const oldRead = monitor.syncMessages().catch(() => {});
  try {
    await reading;
    const start = Date.now();
    await prepareCheckpoint("checkpoint", hang ? 100 : 1000, {
      exec: () => exec,
      send(type, payload) {
        if (type === "checkpoint_status") phases.push((payload as { phase: string }).phase);
        return true;
      },
      pump: async () => {},
      readAgentApiStatus: monitor.readAgentApiStatus.bind(monitor),
      syncAgentApiMessages: monitor.syncMessages.bind(monitor),
      child: () => child,
      childExited: () => exited,
      closeTerminals: async () => {},
      setQuiescing: () => {},
    });
    if (hang) {
      expect(phases).toEqual(["quiescing", "failed"]);
      expect(Date.now() - start).toBeLessThan(500);
      expect(exited).toBe(false);
    } else {
      expect(phases).toEqual(["quiescing", "quiesced"]);
      expect(reads).toBe(2);
      expect(contents).toEqual(["accepted", "completed"]);
    }
  } finally {
    release();
    await oldRead;
    child.kill("SIGKILL");
    await child.exited;
    await server.stop(true);
  }
});
