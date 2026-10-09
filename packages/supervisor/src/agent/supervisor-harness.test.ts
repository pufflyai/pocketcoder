import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { type AgentFrame, ExecSpecSchema, ProviderInputSchema } from "@pstdio/pocketcoder-contracts";
import { SupervisorLogs } from "../observability/supervisor-logs";
import { createSupervisorHarness } from "./supervisor-harness";

function fixture(command: string[]) {
  const input = ProviderInputSchema.parse({
    workspace_id: randomUUID(),
    server_url: "http://127.0.0.1:1",
    registration_secret: "single-use",
    template_name: "harness",
    template_version: "1.0.0",
    template_digest: `sha256:${"a".repeat(64)}`,
    launch_mode: "restore",
  });
  const exec = ExecSpecSchema.parse({
    setup: [],
    env: {},
    persistence: { mounts: [], conversation_restore: "filesystem_only" },
    checkpoint_hook: null,
    outputs: {},
    harness: { command, env: {} },
    services: {},
    launch_mode: "restore",
    restore: { mode: "provider_installed", checkpoint_id: randomUUID(), origin_workspace_id: randomUUID() },
    timeouts: { start: "2s", maxAge: "1h", idle: "1h", disconnectGrace: "2s", terminateGrace: "2s" },
  });
  return { input, exec };
}

test("running and legacy restore ready frames retain the actual spawned child first", async () => {
  const f = fixture([process.execPath, "-e", 'console.log("real harness");']);
  const frames: Array<{ type: AgentFrame["type"]; payload: unknown }> = [];
  let exit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    exit = resolve;
  });
  const send = (type: AgentFrame["type"], payload: unknown) => {
    if (type === "process_state" && (payload as { phase: string }).phase === "running") {
      expect(harness.child?.pid).toBeGreaterThan(0);
      expect(harness.phase).toBe("running");
    }
    if (type === "restore_status") expect(harness.child?.pid).toBeGreaterThan(0);
    frames.push({ type, payload });
    return true;
  };
  const harness = createSupervisorHarness(f.input, {
    send,
    logs: new SupervisorLogs(send),
    close: async () => {},
    isQuiesced: () => false,
    exit,
  });
  try {
    expect(await harness.start(f.exec)).toBe(true);
    expect(await exited).toBe(0);
    await harness.drained;
    expect(frames.filter((f) => f.type !== "log_chunk")).toEqual([
      { type: "process_state", payload: { phase: "running" } },
      { type: "restore_status", payload: { phase: "ready", capability: "filesystem_only" } },
      { type: "process_state", payload: { phase: "exited", exit_code: 0 } },
    ]);
  } finally {
    harness.child?.kill("SIGKILL");
    await harness.child?.exited;
  }
});

test("native spawn failure logs a redacted error and closes without readiness", async () => {
  const secret = randomUUID();
  const f = fixture([`/tmp/pc-no-such-harness-${secret}`]);
  const frames: Array<{ type: AgentFrame["type"]; payload: unknown }> = [];
  const send = (type: AgentFrame["type"], payload: unknown) => {
    frames.push({ type, payload });
    return true;
  };
  const logs = new SupervisorLogs(send);
  logs.addSecret(secret);
  let closed = false;
  const harness = createSupervisorHarness(f.input, {
    send,
    logs,
    close: async () => {
      closed = true;
    },
    isQuiesced: () => false,
    exit: () => {
      throw new Error("Spawn failure must not wait for a child exit");
    },
  });
  expect(await harness.start(f.exec)).toBe(false);
  expect(closed).toBe(true);
  expect(harness.child).toBeNull();
  expect(frames.map((frame) => frame.type)).toEqual(["log_chunk", "process_state"]);
  expect(frames[1]?.payload).toEqual({ phase: "exited", exit_code: 30, setup_step: "harness-start" });
  const first = frames[0];
  if (!first) throw new Error("Failure log missing");
  const log = Buffer.from((first.payload as { content_b64: string }).content_b64, "base64").toString();
  expect(log).toContain("ENOENT");
  expect(log).toContain("[redacted]");
  expect(log).not.toContain(secret);
});
