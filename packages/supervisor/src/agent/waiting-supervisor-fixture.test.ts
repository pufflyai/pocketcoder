import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type AgentFrame,
  type ExecSpec,
  PROTOCOL_VERSION,
  parseWorkloadTemplate,
  type ServerFrame,
  waitingExecSpec,
  workloadSnapshotOf,
} from "@pstdio/pocketcoder-contracts";

export async function fixture(command: string[], configure?: (exec: ExecSpec, root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc-waiting-")));
  const workspaceId = randomUUID();
  const execution = {
    workspaceId,
    incarnationId: "observed-container",
    owner: "process" as const,
    requestId: randomUUID(),
  };
  const template = await Bun.file(
    resolve(import.meta.dir, "../../../../examples/workloads/finite-process.json"),
  ).json();
  template.spec.adapters.main.command = command;
  template.spec.network = { mode: "unrestricted" };
  const exec = waitingExecSpec(workloadSnapshotOf(parseWorkloadTemplate(template)), execution.incarnationId, "create");
  exec.security.writable_memory_paths = [root];
  await configure?.(exec, root);
  const frames: AgentFrame[] = [];
  let socket: { send(raw: string): unknown; close(): void } | null = null;
  let connectionId = "";
  let seq = 0;
  let registrations = 0;
  const send = (type: ServerFrame["type"], payload: unknown) =>
    socket?.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        workspace_id: workspaceId,
        connection_id: connectionId,
        seq: ++seq,
        sent_at: new Date().toISOString(),
        type,
        payload,
      }),
    );
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response(null, { status: 404 });
    },
    websocket: {
      message(ws, raw) {
        const frame = JSON.parse(String(raw)) as AgentFrame;
        frames.push(frame);
        socket = ws;
        connectionId = frame.connection_id;
        if (frame.type === "registered") {
          registrations++;
          send("registered_ack", {
            epoch: registrations,
            reconnect_credential: "memory-only",
            limits: { max_frame_bytes: 1048576, max_inflight_relay: 8, log_chunk_bytes: 65536, heartbeat_seconds: 15 },
            exec,
          });
        }
      },
    },
  });
  const inputPath = join(root, "input.json");
  await Bun.write(
    inputPath,
    JSON.stringify({
      workspace_id: workspaceId,
      server_url: `http://127.0.0.1:${server.port}`,
      registration_secret: "single-use",
      template_name: template.metadata.name,
      template_version: "1.0.0",
      template_digest: `sha256:${"a".repeat(64)}`,
      launch_mode: "create",
    }),
  );
  const child = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "../index.ts"), "supervise", "--launch-input", inputPath],
    { stdout: "pipe", stderr: "pipe" },
  );
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 4000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(frames)}`);
      await Bun.sleep(10);
    }
  };
  return {
    root,
    frames,
    execution,
    child,
    send,
    waitFor,
    disconnect: () => socket?.close(),
    get registrations() {
      return registrations;
    },
    async close() {
      child.kill("SIGKILL");
      await child.exited;
      await server.stop(true);
      await rm(root, { recursive: true, force: true });
    },
  };
}

export const facts = (frames: AgentFrame[]) =>
  frames
    .filter((frame): frame is Extract<AgentFrame, { type: "finite_process" }> => frame.type === "finite_process")
    .map((frame) => frame.payload);
