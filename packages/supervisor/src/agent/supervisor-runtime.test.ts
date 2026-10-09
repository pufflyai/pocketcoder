import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PROTOCOL_VERSION, type ProviderInput, type RestoreTransferSpec } from "@pstdio/pocketcoder-contracts";
import { downloadFixture } from "../checkpoints/filesystem-download-fixture";

// A real supervisor process receives a real control frame and streams over HTTP.
test.each(["complete", "truncated"])(
  "restore setup and harness stay blocked until verified HTTP installation (%s)",
  async (mode) => {
    const f = await downloadFixture();
    const archive = await f.boundArchive();
    const wire = new Uint8Array(await new Response(archive.stream).arrayBuffer());
    const workspaceId = randomUUID();
    const setupMarker = join(f.root, "setup-marker");
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    let downloaded!: () => void;
    const downloadStarted = new Promise<void>((resolveStarted) => {
      downloaded = resolveStarted;
    });
    let ran!: () => void;
    const running = new Promise<void>((resolveRunning) => {
      ran = resolveRunning;
    });
    const phases: string[] = [];
    let grant: RestoreTransferSpec;
    const server = Bun.serve({
      port: 0,
      async fetch(request, server) {
        if (server.upgrade(request)) return;
        expect(request.headers.get("x-pocketcoder-workspace")).toBe(workspaceId);
        expect(request.headers.get("authorization")).toBe("Bearer restore-secret");
        downloaded();
        await gate;
        return new Response(mode === "complete" ? wire : wire.subarray(0, wire.length - 1));
      },
      websocket: {
        message(ws, raw) {
          const frame = JSON.parse(String(raw));
          const send = (type: string, payload: unknown) =>
            ws.send(
              JSON.stringify({
                v: PROTOCOL_VERSION,
                type,
                workspace_id: workspaceId,
                connection_id: frame.connection_id,
                seq: 1,
                sent_at: new Date().toISOString(),
                payload,
              }),
            );
          if (frame.type === "registered")
            send("registered_ack", {
              epoch: 2,
              reconnect_credential: "reconnect-secret",
              limits: {
                max_frame_bytes: 1048576,
                max_inflight_relay: 8,
                log_chunk_bytes: 65536,
                heartbeat_seconds: 15,
              },
              exec: {
                setup: [
                  {
                    name: "prove-restored",
                    command: [
                      process.execPath,
                      "-e",
                      `const b=await Bun.file(${JSON.stringify(join(f.work, "a"))}).arrayBuffer(); await Bun.write(${JSON.stringify(setupMarker)},b);`,
                    ],
                    env: {},
                    runOn: ["restore"],
                  },
                ],
                harness: {
                  command: [
                    process.execPath,
                    "-e",
                    'process.on("SIGTERM",()=>process.exit(0)); console.log("harness-ready"); setInterval(()=>{},100);',
                  ],
                  env: {},
                },
                env: {},
                services: {},
                timeouts: { start: "2s", maxAge: "1h", idle: "1h", disconnectGrace: "2s", terminateGrace: "2s" },
                launch_mode: "restore",
                restore: {
                  mode: "controller_archive",
                  checkpoint_id: grant.checkpoint_id,
                  origin_workspace_id: f.header.workspace_id,
                  transfer: grant,
                },
                persistence: { mounts: grant.mounts, conversation_restore: "filesystem_only" },
                checkpoint_hook: null,
                outputs: {},
              },
            });
          if (frame.type === "checkpoint_installed") phases.push(frame.payload.phase);
          if (frame.type === "restore_status" && frame.payload.phase === "ready") phases.push("ready");
          if (frame.type === "process_state" && frame.payload.phase === "exited") {
            phases.push("exited");
            ran();
          }
          if (frame.type === "process_state" && frame.payload.phase === "running") {
            phases.push("running");
          }
          if (
            frame.type === "log_chunk" &&
            Buffer.from(frame.payload.content_b64, "base64").toString().includes("harness-ready")
          )
            ran();
        },
      },
    });
    const url = `http://127.0.0.1:${server.port}`;
    grant = {
      operation_id: randomUUID(),
      transfer_id: randomUUID(),
      checkpoint_id: f.header.checkpoint_id,
      credential: "restore-secret",
      url: `${url}/v1/agent/checkpoints/restore/archive`,
      expires_at: new Date(Date.now() + 4000).toISOString(),
      source: {
        checkpoint_id: f.header.checkpoint_id,
        workspace_id: f.header.workspace_id,
        template_digest: f.header.template_digest,
        archive_digest: archive.binding.source.archiveDigest,
      },
      mounts: f.mounts.map(({ parent, policy }) => ({ ...policy, target: parent })),
      max_archive_bytes: 1_000_000,
      max_index_bytes: 1_000_000,
      max_ledger_bytes: 1_000_000,
    };
    const inputPath = join(f.root, "provider.json");
    const input: ProviderInput = {
      workspace_id: workspaceId,
      server_url: url,
      registration_secret: "single-use",
      template_name: "restore",
      template_version: "1.0.0",
      template_digest: f.header.template_digest,
      launch_mode: "restore",
    };
    await writeFile(inputPath, JSON.stringify(input));
    const worker = Bun.spawn(
      [globalThis.process.execPath, resolve(import.meta.dir, "../index.ts"), "supervise", "--launch-input", inputPath],
      { stdout: "pipe", stderr: "pipe" },
    );
    try {
      await downloadStarted;
      expect(await Bun.file(setupMarker).exists()).toBe(false);
      expect(phases).toEqual([]);
      release();
      await running;
      if (mode === "complete") {
        expect(phases).toEqual(["installed", "running", "ready"]);
        expect(await readFile(setupMarker)).toEqual(f.bytes);
        worker.kill("SIGTERM");
        expect(await worker.exited).toBe(0);
      } else {
        expect(phases).toEqual(["failed", "exited"]);
        expect(await Bun.file(setupMarker).exists()).toBe(false);
        expect(await worker.exited).toBe(30);
      }
    } finally {
      release();
      worker.kill("SIGKILL");
      await worker.exited;
      await server.stop(true);
      await chmod(join(f.work, "z"), 0o700).catch(() => {});
      await f.close();
    }
  },
);
