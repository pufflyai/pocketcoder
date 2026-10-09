import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AgentFrameSchema, PROTOCOL_VERSION, snapshotServices } from "@pstdio/pocketcoder-contracts";
import { DockerDriver, FilesystemStorageDriver } from "@pstdio/pocketcoder-drivers";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { WSContext } from "hono/ws";
import { buildServer } from "../app";
import { checkpointHttpFixture } from "../persistence/checkpoint-transfer-fixture.test";
import { prepareDisposableRuntimeStorage } from "../persistence/disposable-runtime-storage";
import type { LiveConnection } from "./hub";
import { handleConnectedFrame } from "./ws-frame-handler";

test("failed native harness spawn cannot complete a restored workspace with no required services", async () => {
  const f = await checkpointHttpFixture(Buffer.from("x"));
  const disk = await realpath(await mkdtemp("/tmp/pc-harness-start-"));
  const mount = join(disk, "mount");
  await mkdir(mount, { mode: 0o700 });
  let worker: ReturnType<typeof spawnSupervisor> | undefined;
  let pipeline = Promise.resolve();
  let server: ReturnType<typeof Bun.serve> | undefined;
  const frames: string[] = [];
  const controller = buildServer({
    store: f.store,
    driver: new DockerDriver({ inputDir: join(disk, "inputs") }),
    storageDriver: new FilesystemStorageDriver({ workspaceRoot: disk, checkpointRoot: f.directory }),
    limits: DEFAULT_LIMITS,
    pepper: "harness-start-fixture",
    workspaceServerUrl: "http://127.0.0.1:0",
    checkpointTransferOptions: {
      directory: f.directory,
      agentBaseUrl: () => server?.url.toString() ?? "",
      limits: {
        deadlineMs: 3000,
        maxArchiveBytes: 65536,
        maxIndexBytes: 65536,
        maxQueueBytes: 65536,
        maxLedgerBytes: 65536,
      },
      retentionLimits: {
        maxCheckpointFiles: 100,
        maxRetainedBytes: 1000000,
        maxRetainedBytesPerPrincipal: 1000000,
        maxCheckpointsPerPrincipal: 10,
      },
      readCapacity: () => {
        throw new Error("Destination must not reserve upload capacity");
      },
    },
  });
  const service = controller.checkpointTransfers;
  if (!service) throw new Error("Checkpoint transfer service missing");
  try {
    await preserveSource(f);
    const at = new Date();
    const id = randomUUID();
    const operationId = randomUUID();
    expect(Object.values(snapshotServices(f.workspace.templateSnapshot)).filter((s) => s.required)).toEqual([]);
    await f.store.insertWorkspace({
      id,
      principalId: f.principal.id,
      externalId: id,
      idempotencyKey: id,
      requestDigest: id,
      templateId: f.template.id,
      templateSnapshot: f.workspace.templateSnapshot,
      launchInput: null,
      metadata: {},
      deadlineAt: new Date(Date.now() + 30000),
      createdAt: at,
      originWorkspaceId: f.workspace.id,
      restoredFromCheckpointId: f.checkpoint.id,
      launchMode: "restore",
    });
    await f.store.transition(id, { from: ["queued"], to: "provisioning", at });
    await f.store.transition(id, { from: ["provisioning"], to: "connected", at });
    await f.store.updateWorkspace(id, { connectionEpoch: 5 }, at);
    await f.store.insertOperation({
      id: operationId,
      principalId: f.principal.id,
      kind: "restore",
      state: "running",
      idempotencyKey: operationId,
      requestDigest: operationId,
      workspaceId: f.workspace.id,
      checkpointId: f.checkpoint.id,
      resultWorkspaceId: id,
      reasonCode: null,
      attemptCount: 1,
      createdAt: at,
      updatedAt: at,
      completedAt: null,
    });
    let connection: LiveConnection | undefined;
    const deps = { ...controller, store: f.store, pepper: "harness-start-fixture" };
    server = Bun.serve({
      port: 0,
      fetch(request, server) {
        if (new URL(request.url).pathname === "/v1/agent/connect") {
          if (server.upgrade(request, { data: undefined })) return;
          return new Response(null, { status: 426 });
        }
        return service.handleDownload(request, operationId);
      },
      websocket: {
        message(ws, raw) {
          pipeline = pipeline.then(async () => {
            const frame = AgentFrameSchema.parse(JSON.parse(String(raw)));
            frames.push(frame.type === "process_state" ? `${frame.type}:${frame.payload.phase}` : frame.type);
            if (frame.type !== "registered") {
              if (!connection) throw new Error("Connection missing");
              await handleConnectedFrame(deps, connection, connection.ws, frame, (_ws, message) => {
                throw new Error(message);
              });
              return;
            }
            connection = controller.hub.attach(
              id,
              frame.connection_id,
              5,
              new WSContext({
                send: (message) => {
                  ws.send(message);
                },
                close: (code, reason) => {
                  ws.close(code, reason);
                },
                raw: ws,
                readyState: ws.readyState,
              }),
              PROTOCOL_VERSION,
            );
            connection.registered = true;
            const row = await f.store.getWorkspace(id);
            if (!row) throw new Error("Destination missing");
            await prepareDisposableRuntimeStorage(f.store, "docker", row, new Date());
            const grant = await service.restoreGrant(connection, row);
            if (!grant) throw new Error("Restore grant missing");
            // The real disposable destination is a private host mount for this process test.
            grant.mounts = grant.mounts.map((policy) => ({ ...policy, target: mount }));
            controller.hub.send(connection, "registered_ack", {
              epoch: 5,
              reconnect_credential: "fixture-reconnect",
              limits: {
                max_frame_bytes: 1048576,
                max_inflight_relay: 8,
                log_chunk_bytes: 65536,
                heartbeat_seconds: 15,
              },
              exec: {
                setup: [],
                harness: { command: [join(disk, "missing-harness")], env: {} },
                env: {},
                services: {},
                timeouts: { start: "2s", maxAge: "1h", idle: "1h", disconnectGrace: "2s", terminateGrace: "2s" },
                launch_mode: "restore",
                restore: {
                  mode: "controller_archive",
                  checkpoint_id: f.checkpoint.id,
                  origin_workspace_id: f.workspace.id,
                  transfer: grant,
                },
                persistence: { mounts: grant.mounts, conversation_restore: "filesystem_only" },
                checkpoint_hook: null,
                outputs: {},
              },
            });
          });
        },
      },
    });
    const inputPath = join(disk, "provider.json");
    await writeFile(
      inputPath,
      JSON.stringify({
        workspace_id: id,
        server_url: server.url.toString(),
        registration_secret: "single-use-fixture",
        template_name: "restore",
        template_version: "1.0.0",
        template_digest: f.header.template_digest,
        launch_mode: "restore",
      }),
    );
    worker = spawnSupervisor(inputPath);
    await worker.exited;
    await pipeline;
    const workspace = await f.store.getWorkspace(id);
    const operation = await f.store.getOperation(operationId);
    expect(await Bun.file(join(mount, "tiny")).text()).toBe("x");
    expect(operation?.state).not.toBe("succeeded");
    expect(workspace?.readyAt).toBeNull();
    expect(workspace?.state).toBe("failed");
    expect(operation?.state).toBe("failed");
    expect(worker.exitCode).toBe(30);
    expect(await new Response(worker.stderr).text()).toBe("");
    expect(frames).not.toContain("process_state:running");
    expect(frames).toContain("process_state:exited");
    expect(frames.filter((type) => type === "restore_status")).toHaveLength(1);
    expect(workspace?.failureLogTail).toContain("Harness start failed:");
    expect(workspace?.failureLogTail).toContain("ENOENT");
  } finally {
    worker?.kill("SIGKILL");
    await worker?.exited;
    await pipeline.catch(() => {});
    await controller.scheduler.drain();
    await service.close();
    await server?.stop(true);
    await f.dispose();
    await rm(disk, { recursive: true, force: true });
  }
});

async function preserveSource(f: Awaited<ReturnType<typeof checkpointHttpFixture>>) {
  const preservation = f.service.preserve(f.workspace, f.checkpoint, f.operationId);
  const upload = await f.grant;
  expect((await fetch(upload.url, { method: "PUT", headers: f.headers(upload), body: f.raw })).status).toBe(201);
  await preservation;
}

function spawnSupervisor(inputPath: string) {
  return Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../../../supervisor/src/index.ts"),
      "supervise",
      "--launch-input",
      inputPath,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
}
