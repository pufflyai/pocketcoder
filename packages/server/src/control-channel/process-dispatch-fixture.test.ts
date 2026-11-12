import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentFrameSchema, PROTOCOL_VERSION } from "@pstdio/pocketcoder-contracts";
import { executionFixture } from "@pstdio/pocketcoder-db/testing";
import { DockerDriver } from "@pstdio/pocketcoder-drivers";
import { DEFAULT_LIMITS, ExecutionDispatcher, Scheduler } from "@pstdio/pocketcoder-runtime-core";
import { WSContext } from "hono/ws";
import { conversationTransport, executionTransport } from "../conversations/execution-transport";
import { LiveTurns } from "../conversations/live-turns";
import { Hub } from "./hub";
import { processTransport } from "./process-dispatch";
import { execSpecOf } from "./ws-auth";
import { handleConnectedFrame } from "./ws-frame-handler";

export async function processDispatchFixture(
  configure?: (source: import("@pstdio/pocketcoder-contracts").WorkloadTemplate) => void,
  shared?: Awaited<ReturnType<typeof executionFixture>> & { hub: Hub },
  options: {
    concurrency?: number;
    workspaceId?: string;
    canDispatch?: () => boolean;
    capabilities?: import("@pstdio/pocketcoder-contracts").WorkloadCapability[];
    readCapacity?: import("@pstdio/pocketcoder-runtime-core").ReadStorageCapacity;
  } = {},
) {
  let root = "";
  const f = await executionFixture(
    (source) => {
      source.spec.network = { mode: "unrestricted" };
      const adapter = source.spec.adapters.main;
      if (!adapter) throw new Error("Adapter missing");
      adapter.command = [
        process.execPath,
        "-e",
        "console.log(process.env.POCKETCODER_OPERATION_INPUT); setTimeout(()=>process.exit(7), 80)",
      ];
      configure?.(source);
    },
    { mode: "disk", base: shared, capabilities: options.capabilities, workspaceId: options.workspaceId },
  );
  root = f.directory ?? "";
  const serviceDirectory = await mkdtemp(join(tmpdir(), "pc-svc-"));
  const hub = shared?.hub ?? new Hub();
  const liveTurns = new LiveTurns(f.store);
  const transport = executionTransport(
    processTransport({ store: f.store, hub, driver: {} }),
    conversationTransport({
      store: f.store,
      hub,
      driver: {},
      liveTurns,
      readCapacity: options.readCapacity,
    }),
  );
  let dispatchFailed = false;
  // Each failed dispatch attempt; readiness (dispatchFailed) only reflects controller-wide trouble.
  let dispatchErrors = 0;
  const dispatcher = new ExecutionDispatcher({
    onHealth: (failed) => {
      dispatchFailed = failed;
    },
    onError: () => {
      dispatchErrors++;
    },
    store: f.store,
    concurrency: options.concurrency ?? 20,
    canDispatch: options.canDispatch,
    transport,
    inspect: async () => ({ exists: true, running: true, containerIdentity: f.runtime.incarnationId }),
  });
  const scheduler = new Scheduler({
    store: f.store,
    driver: new DockerDriver(),
    connections: hub,
    limits: DEFAULT_LIMITS,
    secrets: { generate: () => "fixture-single-use", digest: (value) => new TextEncoder().encode(value) },
    workspaceServerUrl: "http://localhost",
  });
  let pipeline = Promise.resolve();
  let dropReplies = false;
  let dropAccept = false;
  let dropAck = false;
  let received = 0;
  const processGroups = new Set<number>();
  let runtimeReady = false;
  let epoch = 1;
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response(null, { status: 404 });
    },
    websocket: {
      message(socket, raw) {
        pipeline = pipeline.then(async () => {
          const frame = AgentFrameSchema.parse(JSON.parse(String(raw)));
          received++;
          if (frame.type === "runtime_ready") runtimeReady = true;
          if (frame.type === "finite_process" && frame.payload.processGroupId)
            processGroups.add(frame.payload.processGroupId);
          const ws = new WSContext({
            send(data) {
              const type = JSON.parse(String(data)).type;
              if ((dropAccept && type === "process_start") || (dropAck && type === "process_ack")) return;
              socket.send(data);
            },
            close: () => socket.close(),
            readyState: 1,
          });
          if (frame.type === "registered") {
            await f.store.updateWorkspace(f.id, { connectionEpoch: epoch }, new Date());
            const conn = hub.attach(f.id, frame.connection_id, epoch++, ws, PROTOCOL_VERSION);
            conn.registered = true;
            const current = await f.store.getWorkspace(f.id);
            if (!current) throw new Error("Workspace missing");
            const exec = execSpecOf(current, null, "provider_installed");
            // Host fixtures provide the private memory mount that drivers supply in containers.
            exec.security.writable_memory_paths = [serviceDirectory];
            hub.send(conn, "registered_ack", {
              epoch: conn.epoch,
              reconnect_credential: "fixture-memory-only",
              limits: {
                max_frame_bytes: 1048576,
                max_inflight_relay: 8,
                log_chunk_bytes: 65536,
                heartbeat_seconds: 15,
              },
              exec,
            });
            return;
          }
          const conn = hub.get(f.id);
          if (conn && !dropReplies)
            await handleConnectedFrame(
              {
                store: f.store,
                liveTurns,
                hub,
                executionDispatcher: dispatcher,
                scheduler,
                pepper: "fixture",
              },
              conn,
              ws,
              frame,
              () => {
                throw new Error("Protocol rejected");
              },
            );
        });
      },
    },
  });
  const input = join(root, `supervisor-input-${f.id}.json`);
  await Bun.write(
    input,
    JSON.stringify({
      workspace_id: f.id,
      server_url: `http://127.0.0.1:${server.port}`,
      registration_secret: "single-use-fixture",
      template_name: "workload-fixture",
      template_version: "1.0.0",
      template_digest: f.runtime.template.digest,
      launch_mode: "create",
    }),
  );
  // Match the shipped supervisor and avoid recompiling its source tree in every child startup.
  const supervisor = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../../../supervisor/src/index.ts")],
    outdir: serviceDirectory,
    target: "bun",
  });
  if (!supervisor.success) throw new Error("Supervisor fixture build failed");
  const child = Bun.spawn(
    [process.execPath, join(serviceDirectory, "index.js"), "supervise", "--launch-input", input],
    { stdout: "pipe", stderr: "pipe" },
  );
  // Drain child output so a full pipe cannot block readiness, and retain failure diagnostics.
  const stderr = new Response(child.stderr).text();
  const stdout = new Response(child.stdout).text();
  const waitFor = async (predicate: () => Promise<boolean>) => {
    const deadline = Date.now() + 4000;
    while (!(await predicate())) {
      if (Date.now() > deadline) {
        child.kill("SIGKILL");
        await child.exited;
        throw new Error(`Process dispatch did not settle: ${await stderr} ${await stdout}`);
      }
      await Bun.sleep(10);
    }
    await pipeline;
  };
  await waitFor(async () => runtimeReady);
  return {
    ...f,
    hub,
    liveTurns,
    dispatcher,
    get dispatchErrors() {
      return dispatchErrors;
    },
    get dispatchFailed() {
      return dispatchFailed;
    },
    scheduler,
    waitFor,
    get dropReplies() {
      return dropReplies;
    },
    set dropReplies(value: boolean) {
      dropReplies = value;
    },
    get dropAccept() {
      return dropAccept;
    },
    set dropAccept(value: boolean) {
      dropAccept = value;
    },
    get dropAck() {
      return dropAck;
    },
    set dropAck(value: boolean) {
      dropAck = value;
    },
    get received() {
      return received;
    },
    get spawned() {
      return processGroups.size;
    },
    disconnect() {
      hub.get(f.id)?.ws.close();
    },
    async dispose() {
      await dispatcher.stop();
      child.kill("SIGKILL");
      await child.exited;
      await pipeline;
      await server.stop(true);
      await rm(serviceDirectory, { recursive: true, force: true });
      if (!shared) await f.dispose();
    },
  };
}
