import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import {
  AgentFrameSchema,
  digestOf,
  ExecutionRuntimeSchema,
  InputObjectReferenceSchema,
  type InstalledWorkload,
  PROTOCOL_VERSION,
  parseWorkloadTemplate,
  type WorkloadAcceptance,
  workloadSnapshotOf,
} from "@pstdio/pocketcoder-contracts";
import { createPGliteFixture } from "@pstdio/pocketcoder-db/testing";
import { DockerDriver, FilesystemInputStorage } from "@pstdio/pocketcoder-drivers";
import { DEFAULT_LIMITS, type ProviderRef } from "@pstdio/pocketcoder-runtime-core";
import { WSContext } from "hono/ws";
import { buildServer } from "../app";
import { seedWaitingWorkspace } from "./waiting-workspace-fixture.test";
import { execSpecOf } from "./ws-auth";
import { handleConnectedFrame } from "./ws-frame-handler";

export const executionDockerImage = "oven/bun@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895";
export async function dockerExecutionFixture(command?: string[]) {
  const f = await createPGliteFixture("execution-docker", "disk");
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc129-installed-")));
  const privateRoot = await realpath(await mkdtemp(join(tmpdir(), "pc129-private-")));
  await chmod(root, 0o755);
  const { digest, source, snapshot } = await installedFixture(root, command);
  const storage = new FilesystemInputStorage(join(privateRoot, "canonical"), []);
  const driver = new DockerDriver({
    inputDir: join(privateRoot, "launch"),
    inputProjection: {
      root: join(privateRoot, "projection"),
      storage,
      privateRoots: [join(privateRoot, "canonical")],
      probeImage: executionDockerImage,
      capacity: { bytes: 16_777_216, files: 256 },
    },
  });
  const built = buildServer({
    store: f.store,
    driver,
    pepper: "fixture-pepper",
    limits: { ...DEFAULT_LIMITS, globalActiveWorkspaces: 20 },
    workspaceServerUrl: "http://localhost",
    inputStorageOptions: {
      driver: storage,
      limits: {
        fileBytes: 1_048_576,
        stagedBytes: 8_388_608,
        files: 16,
        transfers: 2,
        transferMs: 30_000,
        retentionMs: 600_000,
      },
      capacity: async () => ({
        workspace: { bytes: 8_388_608, files: 16 },
        principal: { bytes: 16_777_216, files: 32 },
        instance: { bytes: 536_870_912, files: 1024 },
        freeDisk: { bytes: 1_073_741_824, files: 4096, headroomBytes: 0, headroomFiles: 0 },
      }),
    },
  });
  const refs: ProviderRef[] = [];
  const { server, drain } = runtimeServer(f, built);
  const waitFor = async (predicate: () => Promise<boolean>) => {
    const deadline = Date.now() + 10_000;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error("Docker execution did not settle");
      await Bun.sleep(20);
    }
    await drain();
  };
  const prepare = async (withFile: boolean) => {
    const { workspace } = await seedWaitingWorkspace(f.store, snapshot);
    const spec = {
      ...workspace.templateSnapshot.spec,
      image: executionDockerImage,
      network: { mode: "unrestricted" as const },
      resources: source.spec.resources,
      command: [
        "/bin/sh",
        "-c",
        `while [ ! -f /fixture/go-${workspace.id} ]; do sleep 0.05; done; exec bun /fixture/index.js supervise --launch-input /run/pocketcoder/input`,
      ],
    };
    const ref = await driver.create({
      workspace: { ...workspace, templateSnapshot: { ...workspace.templateSnapshot, spec } },
      input: {
        workspace_id: workspace.id,
        server_url: `http://host.docker.internal:${server.port}`,
        registration_secret: `single-use-${workspace.id}`,
        template_name: snapshot.name,
        template_version: snapshot.version,
        template_digest: snapshot.digest,
        launch_mode: "create",
      },
      mounts: [
        { name: "installed-supervisor", target: "/fixture", source: { kind: "host-path", path: root }, readOnly: true },
      ],
      secrets: [],
    });
    refs.push(ref);
    const observed = await driver.inspect(ref);
    if (!observed.containerIdentity || !observed.inputStorage) throw new Error("Observed runtime and storage missing");
    const measured = Bun.spawn(["docker", "exec", ref.id, "sha256sum", "/fixture/index.js"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (
      `sha256:${(await new Response(measured.stdout).text()).split(" ")[0]}` !== digest ||
      (await measured.exited) !== 0
    )
      throw new Error("Installed supervisor digest mismatch");
    const capabilities: InstalledWorkload["capabilities"] = [
      "explicit-start",
      "exact-exit",
      "targeted-cancel",
      "request-lookup",
      "deduplicated-accept",
      "stop-before-export",
      "immutable-inputs",
    ];
    const producer: InstalledWorkload = {
      workspaceId: workspace.id,
      incarnationId: observed.containerIdentity,
      templateDigest: snapshot.digest,
      image: executionDockerImage,
      runtime: source.spec.runtime,
      storage: observed.inputStorage,
      capabilities,
      adapters: { main: { kind: "process", digest, protocol: source.spec.adapters.main.protocol, capabilities } },
    };
    await f.store.transition(workspace.id, {
      from: ["queued"],
      to: "provisioning",
      at: new Date(),
      patch: { providerKind: "docker", providerRef: ref },
    });
    if (
      !(await f.store.bindWorkspaceRuntime(
        workspace.id,
        {
          incarnationId: observed.containerIdentity,
          containerIdentity: observed.containerIdentity,
          profile: "finite-process",
          template: snapshot,
          producer,
        },
        ref,
      ))
    )
      throw new Error("Runtime bind failed");
    await f.store.transition(workspace.id, { from: ["provisioning"], to: "connected", at: new Date() });
    await Bun.write(join(root, `go-${workspace.id}`), "start");
    await waitFor(async () => (await f.store.getWorkspace(workspace.id))?.state === "ready");
    const key = issueMachineKey("fixture-pepper");
    await f.store.insertMachineKey({
      id: key.id,
      principalId: workspace.principalId,
      secretDigest: key.secretDigest,
      scopes: [],
      createdAt: new Date(),
      expiresAt: workspace.deadlineAt,
      revokedAt: null,
      lastUsedAt: null,
    });
    const objects = [];
    if (withFile) {
      const upload = await built.app.request(`/v1/workspaces/${workspace.id}/attachments/${randomUUID()}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${key.token}`,
          "content-type": "text/plain",
          "content-length": "12",
          "content-disposition": 'attachment; filename="input.txt"',
          "x-content-sha256": new Bun.CryptoHasher("sha256").update("pinned-input").digest("hex"),
        },
        body: "pinned-input",
      });
      if (upload.status !== 201) throw new Error(`Public upload failed: ${await upload.text()}`);
      const reference = InputObjectReferenceSchema.parse(await upload.json());
      objects.push(reference);
    }
    const response = await built.app.request(`/v1/workspaces/${workspace.id}/execution-runtime`, {
      headers: { authorization: `Bearer ${key.token}` },
    });
    if (response.status !== 200) throw new Error("Public execution descriptor unavailable");
    const descriptor = ExecutionRuntimeSchema.parse(await response.json());
    const contents = { workspaceId: descriptor.workspaceId, incarnationId: descriptor.incarnationId, objects };
    const facts = {
      execution: {
        workspaceId: workspace.id,
        incarnationId: descriptor.incarnationId,
        owner: "process" as const,
        requestId: randomUUID(),
      },
      callerPrincipalId: descriptor.callerPrincipalId,
      templateDigest: descriptor.template.digest,
      adapterDigest: descriptor.producer.adapters.main?.digest ?? "",
      operation: "run",
      input: {},
      inputs: { ...contents, digest: digestOf(contents) },
      bindingSetDigest: digestOf([]),
    };
    const acceptance: WorkloadAcceptance = { ...facts, fingerprint: digestOf(facts) };
    return { workspace, ref, token: key.token, acceptance };
  };
  return {
    ...f,
    ...built,
    driver,
    prepare,
    waitFor,
    producerDigest: digest,
    async dispose() {
      await Promise.all(
        refs.map(async (ref) => {
          built.hub.close(String(ref.workspaceId));
          await driver.remove(ref);
        }),
      );
      await drain();
      await server.stop(true);
      await f.dispose();
      await rm(root, { recursive: true, force: true });
      await rm(privateRoot, { recursive: true, force: true });
    },
  };
}

function runtimeServer(f: Awaited<ReturnType<typeof createPGliteFixture>>, built: ReturnType<typeof buildServer>) {
  let pipeline = Promise.resolve();
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return built.app.fetch(request);
    },
    websocket: {
      message(socket, raw) {
        pipeline = pipeline.then(async () => {
          const frame = AgentFrameSchema.parse(JSON.parse(String(raw)));
          const ws = new WSContext({
            send: (data) => {
              socket.send(data);
            },
            close: () => socket.close(),
            readyState: 1,
          });
          if (frame.type === "registered") {
            const previous = await f.store.getWorkspace(frame.workspace_id);
            if (!previous) throw new Error("Workspace missing");
            const epoch = previous.connectionEpoch + 1;
            await f.store.updateWorkspace(previous.id, { connectionEpoch: epoch }, new Date());
            const conn = built.hub.attach(previous.id, frame.connection_id, epoch, ws, PROTOCOL_VERSION);
            conn.registered = true;
            built.hub.send(conn, "registered_ack", {
              epoch,
              reconnect_credential: "memory-only-fixture",
              limits: {
                max_frame_bytes: 1048576,
                max_inflight_relay: 8,
                log_chunk_bytes: 65536,
                heartbeat_seconds: 15,
              },
              exec: execSpecOf(previous, null, "provider_installed"),
            });
          } else {
            const conn = built.hub.get(frame.workspace_id);
            if (conn)
              await handleConnectedFrame(
                {
                  store: f.store,
                  hub: built.hub,
                  scheduler: built.scheduler,
                  executionDispatcher: built.executionDispatcher,
                  pepper: "fixture-pepper",
                },
                conn,
                ws,
                frame,
                () => {
                  throw new Error("Protocol rejected");
                },
              );
          }
        });
      },
    },
  });
  return { server, drain: () => pipeline };
}

async function installedFixture(root: string, command?: string[]) {
  const compiled = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../../../supervisor/src/index.ts")],
    outdir: root,
    target: "bun",
  });
  if (!compiled.success) throw new Error("Supervisor build failed");
  const digest = `sha256:${new Bun.CryptoHasher("sha256").update(await Bun.file(join(root, "index.js")).bytes()).digest("hex")}`;
  const source = await Bun.file(resolve(import.meta.dir, "../../../../examples/workloads/finite-process.json")).json();
  source.spec.image = executionDockerImage;
  source.spec.runtime.digest = digest;
  source.spec.adapters.main.digest = digest;
  source.spec.network = { mode: "unrestricted" };
  source.spec.resources = { cpu: "0.1", memory: "256Mi" };
  source.spec.adapters.main.command = [
    "bun",
    "-e",
    `const dir=process.env.POCKETCODER_INPUT_DIRECTORY;if(dir){const manifest=await Bun.file(dir+'/manifest.json').json();if(manifest.objects.length!==1)process.exit(8);const id=manifest.objects[0].fileId;if(await Bun.file(dir+'/'+id).text()!=='pinned-input')process.exit(9);}process.exit(7);`,
  ];
  if (command) source.spec.adapters.main.command = command;
  const snapshot = workloadSnapshotOf(parseWorkloadTemplate(source));
  return { digest, source, snapshot };
}
