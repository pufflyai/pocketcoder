import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PROTOCOL_VERSION } from "@pstdio/pocketcoder-contracts";
import { EXIT_NETWORK_POLICY_FAILED } from "./supervisor-constants";

test("fails before setup when the restricted network boundary is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pocketcoder-network-preflight-"));
  const inputPath = join(root, "input.json");
  const workspaceId = randomUUID();
  const frames: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      message(socket, message) {
        const frame = JSON.parse(String(message)) as {
          type: string;
          connection_id: string;
          payload?: { state?: string };
        };
        if (frame.type === "network_state") frames.push(frame.payload?.state ?? "");
        if (frame.type !== "registered") return;
        socket.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: "registered_ack",
            workspace_id: workspaceId,
            connection_id: frame.connection_id,
            seq: 1,
            sent_at: new Date().toISOString(),
            payload: {
              epoch: 1,
              reconnect_credential: "reconnect",
              limits: {
                max_frame_bytes: 1_048_576,
                max_inflight_relay: 8,
                log_chunk_bytes: 32_768,
                heartbeat_seconds: 15,
              },
              exec: {
                setup: [],
                harness: { command: ["/bin/true"], env: {} },
                env: {},
                services: {},
                timeouts: {
                  start: "2s",
                  maxAge: "1h",
                  idle: "1h",
                  disconnectGrace: "2s",
                  terminateGrace: "2s",
                },
                security: { writable_memory_paths: [] },
                network: {
                  mode: "restricted",
                  proxy_url: "http://127.0.0.1:18080",
                  health_url: "http://127.0.0.1:1/healthz",
                },
                launch_mode: "create",
                source: null,
                restore: null,
                persistence: { mounts: [], conversation_restore: "filesystem_only" },
                checkpoint_hook: null,
                outputs: {},
              },
            },
          }),
        );
      },
    },
  });
  await writeFile(
    inputPath,
    JSON.stringify({
      workspace_id: workspaceId,
      server_url: `http://127.0.0.1:${server.port}`,
      registration_secret: "registration",
      template_digest: "sha256:network-test",
      template_name: "network-test",
      template_version: "1.0.0",
      launch_mode: "create",
    }),
  );
  const supervisor = Bun.spawn([
    process.execPath,
    "--no-env-file",
    resolve(import.meta.dir, "index.ts"),
    "supervise",
    "--launch-input",
    inputPath,
  ]);
  try {
    expect(await supervisor.exited).toBe(EXIT_NETWORK_POLICY_FAILED);
    expect(frames).toEqual(["starting", "degraded"]);
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 5_000);
