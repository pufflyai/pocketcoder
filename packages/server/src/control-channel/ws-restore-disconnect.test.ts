import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { digestOpaque } from "@pstdio/pocketcoder-auth";
import { DockerDriver, FilesystemStorageDriver } from "@pstdio/pocketcoder-drivers";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { buildServer } from "../app";
import { checkpointHttpFixture } from "../persistence/checkpoint-transfer-fixture.test";
import { prepareDisposableRuntimeStorage } from "../persistence/disposable-runtime-storage";

test.each(["transfer", "setup"])("interrupted restore during %s fails and settles before reconnect", async (phase) => {
  const f = await checkpointHttpFixture(Buffer.from("exact source"));
  const mount = join(f.directory, "..", "mount");
  await mkdir(mount, { mode: 0o700 });
  const marker = join(mount, "setup-started");
  const id = randomUUID();
  const operationId = randomUUID();
  const pepper = "restore-interruption";
  const registration = randomUUID();
  let baseUrl = "";
  let worker: ReturnType<typeof spawnSupervisor> | undefined;
  let interrupted = false;
  let interruption: Promise<void> | undefined;
  let downloadRequest: Request | undefined;
  const controller = buildServer({
    store: f.store,
    driver: new DockerDriver({ inputDir: join(f.directory, "..", "inputs") }),
    storageDriver: new FilesystemStorageDriver({
      workspaceRoot: join(f.directory, "..", "live"),
      checkpointRoot: f.directory,
    }),
    pepper,
    limits: DEFAULT_LIMITS,
    workspaceServerUrl: "http://127.0.0.1",
    checkpointTransferOptions: {
      directory: f.directory,
      agentBaseUrl: () => baseUrl,
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
        throw new Error("Restore cannot reserve upload storage");
      },
    },
  });
  const listener = Bun.serve({
    port: 0,
    async fetch(request, server) {
      const response = await controller.agentApp.fetch(request, server);
      if (request.method === "GET" && new URL(request.url).pathname.endsWith("/archive")) downloadRequest = request;
      if (phase === "transfer" && request.method === "GET" && new URL(request.url).pathname.endsWith("/archive")) {
        interrupted = true;
        controller.hub.get(id)?.ws.close(1000, "interrupted download");
      }
      return response;
    },
    websocket: controller.websocket,
  });
  baseUrl = listener.url.toString();
  try {
    const publishing = f.service.preserve(f.workspace, f.checkpoint, f.operationId);
    const upload = await f.grant;
    expect((await fetch(upload.url, { method: "PUT", headers: f.headers(upload), body: f.raw })).status).toBe(201);
    await publishing;
    const at = new Date();
    const snapshot = structuredClone(f.workspace.templateSnapshot);
    const policy = snapshot.spec.persistence.mounts[0];
    if (!policy) throw new Error("Fixture mount missing");
    policy.target = mount;
    snapshot.spec.services = {};
    const harness = snapshot.spec.harness;
    if (!harness) throw new Error("Fixture harness missing");
    harness.command = [process.execPath, "-e", "setInterval(()=>{},100)"];
    snapshot.spec.setup = [
      {
        name: "wait-during-restore",
        runOn: ["restore"],
        timeoutSeconds: 3,
        env: {},
        command: [process.execPath, "-e", `await Bun.write(${JSON.stringify(marker)},'setup');await Bun.sleep(1500)`],
      },
    ];
    await f.store.insertWorkspace({
      id,
      principalId: f.principal.id,
      externalId: id,
      idempotencyKey: id,
      requestDigest: id,
      templateId: f.template.id,
      templateSnapshot: snapshot,
      launchInput: null,
      metadata: {},
      deadlineAt: new Date(Date.now() + 30000),
      createdAt: at,
      originWorkspaceId: f.workspace.id,
      restoredFromCheckpointId: f.checkpoint.id,
      launchMode: "restore",
    });
    await f.store.transition(id, { from: ["queued"], to: "provisioning", at });
    await f.store.updateWorkspace(
      id,
      { registrationDigest: digestOpaque(pepper, registration), registrationExpiresAt: new Date(Date.now() + 30000) },
      at,
    );
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
    const destination = await f.store.getWorkspace(id);
    if (!destination) throw new Error("Destination missing");
    await prepareDisposableRuntimeStorage(f.store, "docker", destination, at);
    const input = join(f.directory, "..", "provider.json");
    await writeFile(
      input,
      JSON.stringify({
        workspace_id: id,
        server_url: baseUrl,
        registration_secret: registration,
        template_name: "restore",
        template_version: "1.0.0",
        template_digest: f.header.template_digest,
        launch_mode: "restore",
      }),
    );
    worker = spawnSupervisor(input);
    if (phase === "setup")
      interruption = (async () => {
        while (!(await Bun.file(marker).exists())) {
          if (worker?.exitCode !== null) throw new Error("Supervisor exited before setup");
          await Bun.sleep(10);
        }
        expect(await readFile(join(mount, "tiny"), "utf8")).toBe("exact source");
        interrupted = true;
        controller.hub.get(id)?.ws.close(1000, "interrupted setup");
      })();
    await interruption;
    for (let i = 0; i < 120 && (await f.store.getOperation(operationId))?.state !== "failed"; i++) await Bun.sleep(10);
    expect(interrupted).toBe(true);
    expect(await f.store.getOperation(operationId)).toMatchObject({ state: "failed", reasonCode: "restore_failed" });
    expect(await f.store.getWorkspace(id)).toMatchObject({
      state: "failed",
      readyAt: null,
      registrationDigest: null,
      reconnectDigest: null,
    });
    expect((await f.store.listWorkspaceStorage(id))[0]?.state).toBe("deleted");
    expect(controller.hub.get(id)).toBeUndefined();
    if (!downloadRequest) throw new Error("Restore did not reach HTTP transfer");
    const transfer = await f.store.checkpointTransfers.get(
      downloadRequest.headers.get("x-checkpoint-transfer-id") ?? "",
    );
    expect(transfer?.grantDigest).toBeNull();
    expect(transfer?.state).toBe(phase === "setup" ? "complete" : "aborted");
    expect(
      (await controller.agentApp.fetch(new Request(downloadRequest.url, { headers: downloadRequest.headers }))).status,
    ).toBe(401);
  } finally {
    worker?.kill("SIGKILL");
    await worker?.exited;
    if (worker) await Promise.all([new Response(worker.stdout).text(), new Response(worker.stderr).text()]);
    await interruption?.catch(() => {});
    await listener.stop(true);
    await controller.scheduler.drain();
    await controller.checkpointTransfers?.close();
    await f.dispose();
  }
});

function spawnSupervisor(input: string) {
  return Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../../../supervisor/src/index.ts"),
      "supervise",
      "--launch-input",
      input,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
}
