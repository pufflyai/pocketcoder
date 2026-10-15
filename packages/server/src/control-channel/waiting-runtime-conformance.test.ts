import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type AgentFrame,
  AgentFrameSchema,
  PROTOCOL_VERSION,
  parseWorkloadTemplate,
  workloadSnapshotOf,
} from "@pstdio/pocketcoder-contracts";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { DockerDriver } from "@pstdio/pocketcoder-drivers";
import { DEFAULT_LIMITS, prepareWaitingRuntime, Scheduler } from "@pstdio/pocketcoder-runtime-core";
import { WSContext } from "hono/ws";
import { Hub, type LiveConnection } from "./hub";
import { seedWaitingWorkspace } from "./waiting-workspace-fixture.test";
import { execSpecOf } from "./ws-auth";
import { handleConnectedFrame } from "./ws-frame-handler";

const image = "oven/bun@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895";
const available =
  Bun.spawnSync(["docker", "image", "inspect", image], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
const createStore = createTestStoreFactory();
async function docker(...args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(error);
  return output.trim();
}

test.skipIf(!available).each(["crash", "deadline", "cancel-owned"])(
  "Docker runtime records exact lifecycle ownership after %s",
  async (ending) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pc-waiting-docker-")));
    const store = await createStore();
    const hub = new Hub();
    const driver = new DockerDriver({ inputDir: join(root, "inputs") });
    let now = new Date();
    const scheduler = new Scheduler({
      now: () => now,
      store,
      driver,
      connections: hub,
      limits: DEFAULT_LIMITS,
      secrets: { generate: () => randomUUID(), digest: (s) => new TextEncoder().encode(s) },
      workspaceServerUrl: "http://localhost",
    });
    const source = await Bun.file(
      resolve(import.meta.dir, "../../../../examples/workloads/finite-process.json"),
    ).json();
    source.spec.adapters.main.command = ["bun", "-e", "setInterval(()=>{},1000)"];
    source.spec.network = { mode: "unrestricted" };
    source.spec.image = image;
    const snapshot = workloadSnapshotOf(parseWorkloadTemplate(source));
    const { workspace, template } = await seedWaitingWorkspace(store, snapshot);
    const id = workspace.id;
    let incarnation = "";
    let connection: LiveConnection | null = null;
    let seq = 0;
    let pipeline = Promise.resolve();
    const received: AgentFrame[] = [];
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
            received.push(frame);
            const ws = new WSContext({
              send: (raw) => {
                socket.send(raw);
              },
              close: () => socket.close(),
              readyState: 1,
            });
            if (frame.type === "registered") {
              await store.updateWorkspace(id, { connectionEpoch: ++seq }, new Date());
              connection = hub.attach(id, frame.connection_id, seq, ws, PROTOCOL_VERSION);
              connection.registered = true;
              const current = await store.getWorkspace(id);
              if (!current) throw new Error("Workspace missing");
              hub.send(connection, "registered_ack", {
                epoch: seq,
                reconnect_credential: "memory-only",
                limits: {
                  max_frame_bytes: 1048576,
                  max_inflight_relay: 8,
                  log_chunk_bytes: 65536,
                  heartbeat_seconds: 15,
                },
                exec: execSpecOf(current, null, "provider_installed"),
              });
            } else if (connection)
              await handleConnectedFrame({ store, hub, scheduler, pepper: "fixture" }, connection, ws, frame, () => {});
          });
        },
      },
    });
    let container = "";
    try {
      const built = await Bun.build({
        entrypoints: [resolve(import.meta.dir, "../../../supervisor/src/index.ts")],
        outdir: root,
        target: "bun",
      });
      expect(built.success).toBe(true);
      await Bun.write(
        join(root, "input.json"),
        JSON.stringify({
          workspace_id: id,
          server_url: `http://host.docker.internal:${server.port}`,
          registration_secret: "fixture-single-use",
          template_name: template.name,
          template_version: template.version,
          template_digest: template.digest,
          launch_mode: "create",
        }),
      );
      // The gate lets the controller bind the driver identity before registration.
      container = await docker(
        "run",
        "-d",
        "--restart=no",
        "--network=bridge",
        "--memory=256m",
        "--cpus=1",
        "-v",
        `${root}:/fixture`,
        image,
        "sh",
        "-c",
        "while [ ! -f /fixture/go ]; do sleep 0.05; done; exec bun /fixture/index.js supervise --launch-input /fixture/input.json",
      );
      const ref = { kind: "docker", id: container };
      const observed = await driver.inspect(ref);
      expect(observed.containerIdentity).toBe(container);
      const unavailableDriver = new DockerDriver({
        inputDir: join(root, "inputs"),
        dockerBin: join(root, "unavailable-docker"),
      });
      await expect(unavailableDriver.inspect(ref)).rejects.toThrow();
      if (!observed.containerIdentity) throw new Error("Container identity missing");
      incarnation = observed.containerIdentity;
      await store.transition(id, {
        from: ["queued"],
        to: "provisioning",
        at: new Date(),
        patch: { providerKind: "docker", providerRef: ref },
      });
      const provisioned = await store.getWorkspace(id);
      if (!provisioned) throw new Error("Workspace missing");
      expect(await prepareWaitingRuntime({ store, driver }, provisioned, snapshot)).toBe(incarnation);
      const registered = await store.getWorkspace(id);
      if (!registered) throw new Error("Registered workspace missing");
      const exec = execSpecOf(registered, null, "provider_installed");
      expect(exec.harness).toBeNull();
      expect(exec.workload?.incarnationId).toBe(incarnation);
      expect(exec.workload?.operations.run?.command).toEqual(source.spec.adapters.main.command);
      await store.transition(id, { from: ["provisioning"], to: "connected", at: new Date() });
      await Bun.write(join(root, "go"), "ready");
      const waitFor = async (predicate: () => Promise<boolean>) => {
        const deadline = Date.now() + 5000;
        while (!(await predicate())) {
          if (Date.now() > deadline) throw new Error("Docker runtime did not reach expected state");
          await Bun.sleep(20);
        }
        await pipeline;
      };
      await waitFor(async () => (await store.getWorkspace(id))?.state === "ready");
      expect((await store.getWorkspace(id))?.finiteProcess).toBeNull();
      now = new Date(Date.now() + 2000);
      await scheduler.sweep();
      expect((await store.getWorkspace(id))?.state).toBe("ready");
      const execution = {
        workspaceId: id,
        incarnationId: incarnation,
        owner: "process" as const,
        requestId: randomUUID(),
      };
      const active = hub.get(id);
      if (!active) throw new Error("Runtime connection missing");
      hub.send(active, "process_start", { execution, fingerprint: `sha256:${"a".repeat(64)}`, operation: "run" });
      await waitFor(async () => (await store.getWorkspace(id))?.finiteProcess?.phase === "running");
      if (ending === "cancel-owned") {
        await store.transition(id, {
          from: ["ready"],
          to: "terminating",
          reason: "canceled_by_caller",
          at: new Date(),
          patch: { terminalIntent: "canceled" },
        });
      }
      if (ending !== "deadline") await docker("kill", "--signal=KILL", container);
      else now = new Date(Date.now() + 600001);
      await scheduler.sweep();
      await scheduler.drain();
      if (ending === "cancel-owned") {
        const current = await store.getWorkspace(id);
        expect(current?.state).toBe("terminating");
        if (!current) throw new Error("Workspace missing");
        await scheduler.finalize(current, "canceled", "canceled_by_caller", new Date());
        expect((await store.getWorkspace(id))?.state).toBe("canceled");
      }
      if (ending === "deadline") {
        expect((await store.getWorkspace(id))?.state).toBe("expired");
        expect((await store.getWorkspace(id))?.reasonCode).toBe("deadline_expired");
      }
      expect((await store.getWorkspace(id))?.finiteProcess).toMatchObject({
        execution,
        phase: ending === "deadline" ? "exited" : "lost",
        exitCode: null,
        signal: ending === "deadline" ? "SIGTERM" : null,
      });
      expect((await store.getWorkspace(id))?.runtimeRegistration?.endedAt).toBeString();
      expect(
        received.filter((frame) => frame.type === "finite_process" && frame.payload.phase === "running"),
      ).toHaveLength(1);
    } finally {
      if (container) await docker("rm", "-f", container).catch(() => {});
      hub.close(id);
      await pipeline;
      await server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  15000,
);
