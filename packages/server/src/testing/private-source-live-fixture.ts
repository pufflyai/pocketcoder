import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TemplateManifestSchema } from "@pstdio/pocketcoder-contracts";
import { DockerDriver, KubernetesDriver } from "@pstdio/pocketcoder-drivers";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { buildServer } from "../app";
import { createIssuerClient } from "../secrets/issuer-client";
import { leaseServiceFixture } from "../secrets/lease-service-fixture";
import { waitFor } from "./e2e-test-support";
import { PRIVATE_SOURCE_HARNESS, PRIVATE_SOURCE_SETUP, privateGitFixture } from "./private-git-fixture";

export async function privateSourceLiveFixture(provider: "docker" | "kubernetes") {
  const image = process.env.POCKETCODER_SOURCE_TEST_IMAGE;
  if (!image) throw new Error("Run bun run test:source:live to build the source fixture image.");
  const host = process.env.POCKETCODER_SOURCE_TEST_HOST ?? "host.docker.internal";
  const git = await privateGitFixture(host);
  const f = await leaseServiceFixture("memory", git.url);
  const directory = await mkdtemp(join(tmpdir(), "pc-source-live-"));
  git.authorize(f.issuer.authorizeSource);
  await f.store.transition(f.workspace.id, { from: ["provisioning"], to: "failed", at: new Date() });
  await f.store.updatePrincipal(f.principal.id, ["admin"], ["*"]);
  const namespace = `pc-source-${randomUUID().slice(0, 8)}`;
  async function kubectl(args: string[]) {
    const proc = Bun.spawn(["kubectl", "-n", namespace, ...args], { stdout: "pipe", stderr: "pipe" });
    const [output, error, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code) throw new Error(`Source fixture Kubernetes command failed: ${error}`);
    return output;
  }
  if (provider === "kubernetes") await kubectl(["create", "namespace", namespace]);
  const driver =
    provider === "docker"
      ? new DockerDriver({ inputDir: join(directory, "inputs") })
      : new KubernetesDriver({ namespace, imagePullPolicy: "Never" });
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
  const callback = `http://${host}:${server.port}`;
  built = buildServer({
    store: f.store,
    driver,
    pepper: f.pepper,
    secretKey: f.encryptionKey.toString("base64url"),
    issuerClient: createIssuerClient({ ca: f.issuer.ca }),
    limits: DEFAULT_LIMITS,
    workspaceServerUrl: callback,
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const client = new PocketCoderClient({ baseUrl, apiKey: f.key.token });
  const name = `private-source-${provider}`;
  const manifest = TemplateManifestSchema.parse({
    apiVersion: "pocketcoder.dev/v1alpha1" as const,
    kind: "Template" as const,
    metadata: { name },
    spec: {
      version: "1.0.0",
      image,
      command: ["bun", "/supervisor.js", "supervise", "--launch-input", "/run/pocketcoder/input"],
      setup: [{ name: "clone", command: ["bun", "-e", PRIVATE_SOURCE_SETUP], timeoutSeconds: 30 }],
      harness: { command: ["bun", "-e", PRIVATE_SOURCE_HARNESS] },
      resources: { cpu: "1", memory: "512Mi", ephemeralStorage: "64Mi" },
      persistence: { mounts: [{ name: "worktree", target: "/worktree", maxBytes: 4 * 1024 ** 2, maxFiles: 1000 }] },
      source: {
        kind: "git" as const,
        destinationMount: "worktree",
        repositories: { app: { url: git.url, credential: "secretRef:source" } },
      },
      services: {
        agent: {
          baseUrl: "http://127.0.0.1:8080",
          healthPath: "/status",
          routes: [{ method: "GET" as const, path: "/source" }],
        },
      },
      timeouts: { start: "30s", maxAge: "1m", idle: "1m", disconnectGrace: "1s", terminateGrace: "1s" },
    },
  });
  await client.templates.publish(manifest);
  let workspaceId: string | null = null;
  return {
    ...f,
    git,
    client,
    built,
    driver,
    manifest,
    kubectl,
    baseUrl,
    async create() {
      const workspace = await client.workspaces.create({
        externalId: randomUUID(),
        templateName: name,
        source: { kind: "git", repository: "app", revision: "main" },
      });
      workspaceId = workspace.id;
      await built.scheduler.tick();
      return workspace.id;
    },
    async close() {
      if (workspaceId) {
        const row = await f.store.getWorkspace(workspaceId);
        if (row && !row.terminalAt) await built.scheduler.finalize(row, "canceled", "canceled_by_caller", new Date());
      }
      await built.scheduler.drain();
      await built.checkpointTransfers?.close();
      await server.stop(true);
      if (provider === "kubernetes") await kubectl(["delete", "namespace", namespace, "--wait=true", "--timeout=30s"]);
      await f.close();
      await git.close();
      await rm(directory, { recursive: true, force: true });
    },
    async ready(id: string) {
      return waitFor(
        async () => {
          const row = await f.store.getWorkspace(id);
          if (row?.terminalAt) throw new Error(`Source workspace failed: ${row.reasonCode}; ${row.failureLogTail}`);
          return row?.state === "ready" ? row : null;
        },
        30_000,
        `${provider} private source readiness`,
      ).catch(async (error) => {
        if (provider === "kubernetes") {
          const pods = await kubectl(["get", "pods", "-o", "json"]);
          throw new Error(`${error}; ${pods}`);
        }
        throw error;
      });
    },
    async failed(id: string) {
      return waitFor(
        async () => {
          const row = await f.store.getWorkspace(id);
          return row?.state === "failed" ? row : null;
        },
        30_000,
        `${provider} failed source cleanup`,
      );
    },
  };
}
