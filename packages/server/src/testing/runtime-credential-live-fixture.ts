import { randomUUID } from "node:crypto";
import { statfsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TemplateManifestSchema } from "@pstdio/pocketcoder-contracts";
import {
  DockerDriver,
  FileSecretResolver,
  FilesystemStorageDriver,
  KubernetesDriver,
} from "@pstdio/pocketcoder-drivers";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { buildServer } from "../app";
import { createIssuerClient } from "../secrets/issuer-client";
import { leaseServiceFixture } from "../secrets/lease-service-fixture";
import { waitFor } from "./e2e-test-support";

const HARNESS = `
Bun.serve({ hostname: "127.0.0.1", port: 8080, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/status") return Response.json({ status: "stable" });
  const credential = await Bun.file(process.env.RUNTIME_TOKEN_FILE).text();
  const resource = new URL(process.env.RESOURCE_URL);
  resource.searchParams.set("workspace", url.searchParams.get("workspace"));
  resource.searchParams.set("resource", "synthetic-source");
  const reply = await fetch(resource, { tls: { ca: process.env.ISSUER_CA }, headers: { authorization: "Bearer " + credential } });
  return Response.json({ status: reply.status, credential });
} });
`;

export async function runtimeCredentialLiveFixture(
  provider: "docker" | "kubernetes",
  checkpoint = false,
  issuerConfigured = true,
) {
  const image = process.env.POCKETCODER_SOURCE_TEST_IMAGE;
  if (!image) throw new Error("Run bun run test:runtime:live to build the fixture image.");
  const host = process.env.POCKETCODER_SOURCE_TEST_HOST ?? "host.docker.internal";
  const f = await leaseServiceFixture("disk", undefined, host);
  const controllerDirectory = f.context.dataDir;
  if (!controllerDirectory) throw new Error("Missing controller directory");
  const directory = await mkdtemp(join(tmpdir(), "pc-runtime-live-"));
  await f.store.transition(f.workspace.id, { from: ["provisioning"], to: "failed", at: new Date() });
  await f.store.updatePrincipal(f.principal.id, ["admin"], ["*"]);
  await f.vault.put(f.key.id, "runtime", { ...f.config, type: "runtime-issuer" });
  f.issuer.controls.leaseLifetimeMs = 8_000;
  const namespace = `pc-runtime-${randomUUID().slice(0, 8)}`;
  async function kubectl(args: string[]) {
    const proc = Bun.spawn(["kubectl", "-n", namespace, ...args], { stdout: "pipe", stderr: "pipe" });
    const [output, error, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code) throw new Error(`Runtime fixture Kubernetes command failed: ${error}`);
    return output;
  }
  if (provider === "kubernetes") await kubectl(["create", "namespace", namespace]);
  const driver =
    provider === "docker"
      ? new DockerDriver({ inputDir: join(directory, "inputs") })
      : new KubernetesDriver({ namespace, imagePullPolicy: "Never" });
  const legacyRoot = join(directory, "legacy-secrets");
  await mkdir(legacyRoot, { mode: 0o700 });
  await writeFile(join(legacyRoot, "runtime"), "synthetic-file-marker", { mode: 0o600 });
  let built: ReturnType<typeof buildServer>;
  const websocket: typeof built.websocket = {
    message(ws, message) {
      built.websocket.message(ws, message);
    },
    open(ws) {
      built.websocket.open?.(ws);
    },
    close(ws, code, reason) {
      built.websocket.close?.(ws, code, reason);
    },
  };
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    fetch: (request, server) =>
      new URL(request.url).pathname.startsWith("/v1/agent/")
        ? built.agentApp.fetch(request, server)
        : built.app.fetch(request, server),
    websocket,
  });
  built = buildServer({
    store: f.store,
    driver,
    pepper: f.pepper,
    secretKey: issuerConfigured ? f.encryptionKey.toString("base64url") : undefined,
    secretResolver: new FileSecretResolver({ root: legacyRoot }),
    ...(checkpoint
      ? {
          storageDriver: new FilesystemStorageDriver({
            workspaceRoot: join(directory, "live"),
            checkpointRoot: join(controllerDirectory, "checkpoints"),
          }),
          checkpointTransferOptions: {
            directory: join(controllerDirectory, "checkpoints"),
            agentBaseUrl: `http://${host}:${server.port}`,
            limits: {
              deadlineMs: 15_000,
              maxArchiveBytes: 1_048_576,
              maxIndexBytes: 65_536,
              maxQueueBytes: 65_536,
              maxLedgerBytes: 65_536,
            },
            retentionLimits: {
              maxRetainedBytes: 16_777_216,
              maxRetainedBytesPerPrincipal: 16_777_216,
              maxCheckpointFiles: 100,
              maxCheckpointsPerPrincipal: 10,
            },
            readCapacity: () => {
              const stats = statfsSync(controllerDirectory);
              return {
                workspace: { bytes: 16_777_216, files: 1000 },
                principal: { bytes: 16_777_216, files: 1000 },
                instance: { bytes: 16_777_216, files: 1000 },
                freeDisk: { bytes: stats.bavail * stats.bsize, files: stats.ffree, headroomBytes: 0, headroomFiles: 0 },
              };
            },
          },
        }
      : {}),
    issuerClient: createIssuerClient({ ca: f.issuer.ca }),
    limits: DEFAULT_LIMITS,
    workspaceServerUrl: `http://${host}:${server.port}`,
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const client = new PocketCoderClient({ baseUrl, apiKey: f.key.token });
  const manifest = TemplateManifestSchema.parse({
    apiVersion: "pocketcoder.dev/v1alpha1",
    kind: "Template",
    metadata: { name: `runtime-${provider}` },
    spec: {
      version: "1.0.0",
      image,
      command: ["bun", "/supervisor.js", "supervise", "--launch-input", "/run/pocketcoder/input"],
      harness: { command: ["bun", "-e", HARNESS] },
      env: { RUNTIME_TOKEN_FILE: "secretRef:runtime", ISSUER_CA: f.issuer.ca, RESOURCE_URL: f.issuer.resourceUrl },
      ...(checkpoint
        ? { persistence: { mounts: [{ name: "worktree", target: "/worktree", maxBytes: 1_048_576, maxFiles: 100 }] } }
        : {}),
      resources: { cpu: "1", memory: "512Mi", ephemeralStorage: "64Mi" },
      services: {
        agent: {
          baseUrl: "http://127.0.0.1:8080",
          healthPath: "/status",
          routes: [{ method: "GET", path: "/runtime", query: ["workspace"] }],
        },
      },
      timeouts: { start: "30s", maxAge: "1m", idle: "1m", disconnectGrace: "1s", terminateGrace: "1s" },
    },
  });
  await client.templates.publish(manifest);
  const ids: string[] = [];
  return {
    ...f,
    built,
    client,
    manifest,
    kubectl,
    async create() {
      const workspace = await client.workspaces.create({
        externalId: randomUUID(),
        templateName: manifest.metadata.name,
      });
      ids.push(workspace.id);
      await built.scheduler.tick();
      return workspace.id;
    },
    track(id: string) {
      ids.push(id);
    },
    async ready(id: string) {
      return waitFor(
        async () => {
          const row = await f.store.getWorkspace(id);
          if (row?.terminalAt) throw new Error(`Runtime workspace failed: ${row.reasonCode}; ${row.failureLogTail}`);
          return row?.state === "ready" ? row : null;
        },
        30_000,
        `${provider} runtime readiness`,
      );
    },
    async request(id: string) {
      const reply = await fetch(`${baseUrl}/v1/workspaces/${id}/services/agent/runtime?workspace=${id}`, {
        headers: { authorization: `Bearer ${f.key.token}` },
      });
      if (!reply.ok) throw new Error(`Runtime relay failed: ${reply.status}; ${await reply.text()}`);
      return (await reply.json()) as { status: number; credential: string };
    },
    async close() {
      f.issuer.controls.reply = "valid";
      for (const id of ids) {
        const row = await f.store.getWorkspace(id);
        if (row && !row.terminalAt) await built.scheduler.finalize(row, "canceled", "canceled_by_caller", new Date());
      }
      await built.scheduler.drain();
      await built.checkpointTransfers?.close();
      await server.stop(true);
      if (provider === "kubernetes") await kubectl(["delete", "namespace", namespace, "--wait=true", "--timeout=30s"]);
      await f.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
