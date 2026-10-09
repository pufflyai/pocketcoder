import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PROTOCOL_VERSION, readCheckpointArchive } from "@pstdio/pocketcoder-contracts";

test("source harness drains, measured HTTP upload completes and control remains live", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc-supervisor-capture-")));
  const mount = join(root, "mount");
  await mkdir(mount);
  const file = join(mount, "saved.bin");
  const bytes = Buffer.from([0, 2, 4, 255, 128, 13, 10]);
  const workspaceId = randomUUID();
  const checkpointId = randomUUID();
  const operationId = randomUUID();
  const transferId = randomUUID();
  let send!: (type: string, payload: unknown) => void;
  let sequence = 0;
  let measured = 0;
  let childExited = false;
  let received!: () => void;
  const bodyReceived = new Promise<void>((r) => {
    received = r;
  });
  let release!: () => void;
  const responseGate = new Promise<void>((r) => {
    release = r;
  });
  let relayed!: () => void;
  const controlResponse = new Promise<void>((r) => {
    relayed = r;
  });
  let uploaded!: () => void;
  const uploadDone = new Promise<void>((r) => {
    uploaded = r;
  });
  const server = Bun.serve({
    port: 0,
    async fetch(request, server) {
      if (server.upgrade(request)) return;
      expect(request.method).toBe("PUT");
      expect(request.headers.get("authorization")).toBe("Bearer source-one-use");
      expect(request.headers.get("x-checkpoint-transfer-id")).toBe(transferId);
      const wire = new Uint8Array(await request.arrayBuffer());
      expect(Number(request.headers.get("content-length"))).toBe(measured);
      expect(wire.length).toBe(measured);
      const payload: Uint8Array[] = [];
      await readCheckpointArchive(new Blob([wire]).stream(), {
        maxArchiveBytes: measured,
        onEntry: async () => {},
        onData: async (_entry, chunk) => {
          payload.push(chunk.slice());
        },
      });
      expect(Buffer.concat(payload)).toEqual(bytes);
      received();
      await responseGate;
      return new Response(null, { status: 204 });
    },
    websocket: {
      message(ws, raw) {
        const frame = JSON.parse(String(raw));
        send = (type, payload) =>
          ws.send(
            JSON.stringify({
              v: PROTOCOL_VERSION,
              type,
              workspace_id: workspaceId,
              connection_id: frame.connection_id,
              seq: ++sequence,
              sent_at: new Date().toISOString(),
              payload,
            }),
          );
        if (frame.type === "registered")
          send("registered_ack", {
            epoch: 1,
            reconnect_credential: "reconnect",
            limits: { max_frame_bytes: 1048576, max_inflight_relay: 8, log_chunk_bytes: 65536, heartbeat_seconds: 15 },
            exec: {
              setup: [],
              harness: {
                command: [
                  process.execPath,
                  "-e",
                  `process.on("SIGTERM",async()=>{await Bun.write(${JSON.stringify(file)},Buffer.from(${JSON.stringify([...bytes])}));process.exit(0)}); console.log("writer-ready"); setInterval(()=>{},100)`,
                ],
                env: {},
              },
              env: {},
              services: {},
              timeouts: { start: "2s", maxAge: "1h", idle: "1h", disconnectGrace: "2s", terminateGrace: "2s" },
              persistence: { mounts: [{ name: "work", target: mount }], conversation_restore: "filesystem_only" },
              checkpoint_hook: null,
              outputs: {},
            },
          });
        if (
          frame.type === "log_chunk" &&
          Buffer.from(frame.payload.content_b64, "base64").toString().includes("writer-ready")
        )
          send("prepare_checkpoint_archive", {
            operation_id: operationId,
            checkpoint_id: checkpointId,
            deadline_ms: 4000,
            mounts: [{ name: "work", target: mount, maxFiles: 10, maxBytes: 1_000_000 }],
            max_archive_bytes: 1_000_000,
            max_index_bytes: 1_000_000,
            max_queue_bytes: 1_000_000,
          });
        if (frame.type === "process_state" && frame.payload.phase === "exited") childExited = true;
        if (frame.type === "checkpoint_prepared") {
          expect(childExited).toBe(true);
          expect(frame.payload.header.mounts).toEqual([{ name: "work", logical_bytes: bytes.length, file_count: 1 }]);
          measured = frame.payload.archive_bytes;
          send("checkpoint_upload", {
            operation_id: operationId,
            checkpoint_id: checkpointId,
            transfer_id: transferId,
            credential: "source-one-use",
            url: `http://127.0.0.1:${server.port}/v1/agent/checkpoints/${operationId}/archive`,
            expires_at: new Date(Date.now() + 3000).toISOString(),
          });
        }
        if (frame.type === "proxy_response") relayed();
        if (frame.type === "checkpoint_upload_status" && frame.payload.phase === "uploaded") uploaded();
      },
    },
  });
  const inputPath = join(root, "input.json");
  await writeFile(
    inputPath,
    JSON.stringify({
      workspace_id: workspaceId,
      server_url: `http://127.0.0.1:${server.port}`,
      registration_secret: "register",
      template_name: "writer",
      template_version: "1.0.0",
      template_digest: `sha256:${"a".repeat(64)}`,
    }),
  );
  const worker = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "../index.ts"), "supervise", "--launch-input", inputPath],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    await bodyReceived;
    expect(worker.exitCode).toBe(null);
    send("proxy_request", {
      request_id: randomUUID(),
      service: "agent",
      method: "GET",
      path: "/health",
      deadline_ms: 500,
    });
    await controlResponse;
    release();
    await uploadDone;
    expect(worker.exitCode).toBe(null);
    expect(await readFile(file)).toEqual(bytes);
    send("shutdown", { reason: "durable publication completed" });
    expect(await worker.exited).toBe(0);
  } finally {
    release();
    worker.kill("SIGKILL");
    await worker.exited;
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
