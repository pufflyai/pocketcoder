import { join, resolve } from "node:path";
import { AgentFrameSchema, PROTOCOL_VERSION } from "@pstdio/pocketcoder-contracts";
import { executionFixture } from "@pstdio/pocketcoder-db/testing";
import { DockerDriver } from "@pstdio/pocketcoder-drivers";
import { DEFAULT_LIMITS, ExecutionDispatcher, Scheduler } from "@pstdio/pocketcoder-runtime-core";
import { WSContext } from "hono/ws";
import { conversationTransport, executionTransport } from "../conversations/execution-transport";
import { Hub } from "./hub";
import { processTransport } from "./process-dispatch";
import { execSpecOf } from "./ws-auth";
import { handleConnectedFrame } from "./ws-frame-handler";

export async function processDispatchFixture(
  configure?: (source: import("@pstdio/pocketcoder-contracts").WorkloadTemplate) => void,
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
    { mode: "disk" },
  );
  root = f.directory ?? "";
  const hub = new Hub();
  const transport = executionTransport(
    processTransport({ store: f.store, hub, driver: {} }),
    conversationTransport({ store: f.store, hub, driver: {} }),
  );
  const dispatcher = new ExecutionDispatcher({
    store: f.store,
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
            hub.send(conn, "registered_ack", {
              epoch: conn.epoch,
              reconnect_credential: "fixture-memory-only",
              limits: {
                max_frame_bytes: 1048576,
                max_inflight_relay: 8,
                log_chunk_bytes: 65536,
                heartbeat_seconds: 15,
              },
              exec: execSpecOf(current, null, "provider_installed"),
            });
            return;
          }
          const conn = hub.get(f.id);
          if (conn && !dropReplies)
            await handleConnectedFrame(
              { store: f.store, hub, executionDispatcher: dispatcher, scheduler, pepper: "fixture" },
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
  const input = join(root, "supervisor-input.json");
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
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../../../supervisor/src/index.ts"),
      "supervise",
      "--launch-input",
      input,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const waitFor = async (predicate: () => Promise<boolean>) => {
    const deadline = Date.now() + 4000;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error("Process dispatch did not settle");
      await Bun.sleep(10);
    }
    await pipeline;
  };
  await waitFor(async () => runtimeReady);
  return {
    ...f,
    hub,
    dispatcher,
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
      child.kill("SIGKILL");
      await child.exited;
      await pipeline;
      await server.stop(true);
      await f.dispose();
    },
  };
}
