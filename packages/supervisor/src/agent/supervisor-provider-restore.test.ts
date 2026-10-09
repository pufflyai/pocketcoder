import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PROTOCOL_VERSION } from "@pstdio/pocketcoder-contracts";

test.each(["provider_installed", "controller_archive"])("explicit %s restore mode with no HTTP grant", async (mode) => {
  const root = await mkdtemp(join(tmpdir(), "pc-provider-restore-"));
  const workspaceId = randomUUID();
  const installedFile = join(root, "provider-installed");
  const setupMarker = join(root, "setup-marker");
  const harnessMarker = join(root, "harness-marker");
  const bytes = Buffer.from([0, 1, 127, 128, 255]);
  await writeFile(installedFile, bytes);
  const phases: string[] = [];
  const restorePhases: string[] = [];
  const logs: string[] = [];
  let httpRequests = 0;
  const copyInstalledFile = (marker: string) =>
    `await Bun.write(${JSON.stringify(marker)}, await Bun.file(${JSON.stringify(installedFile)}).arrayBuffer());`;
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      httpRequests++;
      return new Response(null, { status: 404 });
    },
    websocket: {
      message(ws, raw) {
        const frame = JSON.parse(String(raw));
        if (frame.type === "process_state") phases.push(frame.payload.phase);
        if (frame.type === "restore_status") restorePhases.push(frame.payload.phase);
        if (frame.type === "log_chunk") logs.push(Buffer.from(frame.payload.content_b64, "base64").toString());
        if (frame.type !== "registered") return;
        ws.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: "registered_ack",
            workspace_id: workspaceId,
            connection_id: frame.connection_id,
            seq: 1,
            sent_at: new Date().toISOString(),
            payload: {
              epoch: 1,
              reconnect_credential: "reconnect-single-workspace",
              limits: {
                max_frame_bytes: 1048576,
                max_inflight_relay: 8,
                log_chunk_bytes: 65536,
                heartbeat_seconds: 15,
              },
              exec: {
                setup: [
                  {
                    name: "read-provider-files",
                    command: [process.execPath, "-e", copyInstalledFile(setupMarker)],
                    env: {},
                    runOn: ["restore"],
                  },
                ],
                harness: { command: [process.execPath, "-e", copyInstalledFile(harnessMarker)], env: {} },
                env: {},
                services: {},
                timeouts: { start: "2s", maxAge: "1h", idle: "1h", disconnectGrace: "2s", terminateGrace: "2s" },
                launch_mode: "restore",
                restore: { mode, checkpoint_id: randomUUID(), origin_workspace_id: randomUUID(), transfer: null },
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
  const inputPath = join(root, "provider.json");
  await writeFile(
    inputPath,
    JSON.stringify({
      workspace_id: workspaceId,
      server_url: server.url.toString(),
      registration_secret: "single-use-registration",
      template_name: "provider-restore",
      template_version: "1.0.0",
      template_digest: `sha256:${"a".repeat(64)}`,
      launch_mode: "restore",
    }),
  );
  const worker = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "../index.ts"), "supervise", "--launch-input", inputPath],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    const code = await worker.exited;
    expect(code).toBe(mode === "provider_installed" ? 0 : 30);
    expect(httpRequests).toBe(0);
    expect(await new Response(worker.stderr).text()).toBe("");
    if (mode === "provider_installed") {
      expect(await readFile(setupMarker)).toEqual(bytes);
      expect(await readFile(harnessMarker)).toEqual(bytes);
      expect(phases).toEqual(["setup", "running", "exited"]);
      expect(restorePhases).toEqual(["validating", "ready"]);
      expect(logs.join("")).not.toContain("installation failed");
    } else {
      expect(await Bun.file(setupMarker).exists()).toBe(false);
      expect(await Bun.file(harnessMarker).exists()).toBe(false);
      expect(phases).toEqual(["exited"]);
      expect(restorePhases).toEqual(["validating"]);
      expect(logs.join("")).toContain("Restore grant is missing.");
    }
  } finally {
    worker.kill("SIGKILL");
    await worker.exited;
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
