import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PROTOCOL_VERSION } from "@pstdio/pocketcoder-contracts";
import type { ServerWebSocket } from "bun";

const cases = [
  { stop: "TERM", sync: "success" },
  { stop: "shutdown", sync: "success" },
  { stop: "SIGTERM", sync: "success" },
  { stop: "TERM", sync: "failure" },
  { stop: "TERM", sync: "slow" },
] as const;
for (const { stop, sync } of cases) {
  test(`native ${stop} stops the child with ${sync} final history sync`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pc-native-stop-"));
    const harnessPath = join(root, "harness.ts");
    const inputPath = join(root, "input.json");
    const readyPath = join(root, "ready");
    const markerPath = join(root, "stopped");
    const workspaceId = randomUUID();
    const frames: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const messages = [
      { id: 1, role: "user", content: "earlier", time: "2026-10-05T12:00:00Z" },
      { id: 2, role: "agent", content: "completed", time: "2026-10-05T12:00:01Z" },
    ];
    let reads = 0;
    let resolveRead!: () => void;
    const firstRead = new Promise<void>((resolvePromise) => {
      resolveRead = resolvePromise;
    });
    const agentapi = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === "/status") return Response.json({ status: "running" });
        reads++;
        resolveRead();
        if (sync === "failure") return new Response("unavailable", { status: 503 });
        if (sync === "slow") return await new Promise<Response>(() => {});
        return Response.json({ messages });
      },
    });
    let serverSeq = 0;
    let socket: ServerWebSocket<undefined> | null = null;
    let connectionId = "";
    const send = (type: string, payload: Record<string, unknown>) => {
      socket?.send(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type,
          workspace_id: workspaceId,
          connection_id: connectionId,
          seq: ++serverSeq,
          sent_at: new Date().toISOString(),
          payload,
        }),
      );
    };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        if (bunServer.upgrade(request, { data: undefined })) return;
        return new Response("upgrade required", { status: 426 });
      },
      websocket: {
        message(ws, raw) {
          const frame = JSON.parse(String(raw));
          frames.push({ type: frame.type, payload: frame.payload });
          if (frame.type !== "registered") return;
          socket = ws;
          connectionId = frame.connection_id;
          send("registered_ack", {
            epoch: 1,
            reconnect_credential: "reconnect",
            limits: { max_frame_bytes: 1048576, max_inflight_relay: 8, log_chunk_bytes: 32768, heartbeat_seconds: 15 },
            exec: {
              agentapi_native: true,
              setup: [],
              harness: { command: [process.execPath, harnessPath], env: {} },
              env: {},
              services: {
                agent: {
                  baseUrl: agentapi.url.toString(),
                  required: true,
                  healthPath: "/status",
                  routes: [{ method: "GET", path: "/messages" }],
                },
              },
              timeouts: {
                start: "2s",
                maxAge: "1h",
                idle: "1h",
                disconnectGrace: "2s",
                terminateGrace: sync === "slow" ? "200ms" : "2s",
              },
              persistence: { mounts: [], conversation_restore: "filesystem_only" },
              checkpoint_hook: null,
              outputs: {},
            },
          });
        },
      },
    });
    await writeFile(
      harnessPath,
      `process.once("SIGTERM", async () => { await Bun.write(${JSON.stringify(markerPath)}, "stopped"); process.exit(0); }); await Bun.write(${JSON.stringify(readyPath)}, "ready"); setInterval(() => {}, 1000);\n`,
    );
    await writeFile(
      inputPath,
      JSON.stringify({
        workspace_id: workspaceId,
        server_url: server.url.toString(),
        registration_secret: "registration",
        template_digest: "sha256:native-stop",
        template_name: "native-stop",
        template_version: "1.0.0",
        launch_mode: "create",
      }),
    );
    const supervisor = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        resolve(import.meta.dir, "../index.ts"),
        "supervise",
        "--launch-input",
        inputPath,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    try {
      const deadline = Date.now() + 2000;
      while (!(await Bun.file(readyPath).exists())) {
        if (Date.now() >= deadline) throw new Error("harness did not start");
        await Bun.sleep(10);
      }
      // Let the first health probe finish before accepting the prompt that Stop must retain.
      await Promise.race([firstRead, Bun.sleep(100)]);
      messages.push(
        { id: 3, role: "user", content: "latest accepted input", time: "2026-10-05T12:01:00Z" },
        { id: 4, role: "agent", content: "unfinished", time: "2026-10-05T12:01:01Z" },
      );
      const stoppedAt = Date.now();
      if (stop === "SIGTERM") process.kill(supervisor.pid, "SIGTERM");
      else if (stop === "TERM") send("signal", { signal: "TERM" });
      else send("shutdown", { reason: "canceled_by_caller" });
      const exitCode = await supervisor.exited;
      if (sync !== "success") {
        expect(exitCode).toBe(sync === "slow" ? 137 : 0);
        expect(Date.now() - stoppedAt).toBeLessThan(1500);
        const logs = frames
          .filter((frame) => frame.type === "log_chunk")
          .map((frame) => Buffer.from(String(frame.payload.content_b64), "base64").toString())
          .join("");
        expect(logs).toContain("Final AgentAPI transcript sync failed");
        return;
      }
      expect(exitCode).toBe(0);
      expect(await Bun.file(markerPath).text()).toBe("stopped");
      const captured = frames.filter((frame) => frame.type === "conversation_message");
      expect(captured.map((frame) => frame.payload.content)).toEqual(["earlier", "completed", "latest accepted input"]);
      const latest = frames.findIndex(
        (frame) => frame.type === "conversation_message" && frame.payload.content === "latest accepted input",
      );
      const exited = frames.findIndex((frame) => frame.type === "process_state" && frame.payload.phase === "exited");
      expect(latest).toBeLessThan(exited);
      expect(reads).toBeGreaterThanOrEqual(2);
    } finally {
      if (supervisor.exitCode === null) supervisor.kill("SIGKILL");
      await supervisor.exited;
      await server.stop(true);
      await agentapi.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  }, 5000);
}
