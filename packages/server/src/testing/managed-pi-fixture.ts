import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { managedPrincipalId } from "../bootstrap/managed-principals/principal-file";
import { loadConfig } from "../config/config";
import { startPocketCoderServer } from "../lifecycle/lifecycle";
import { createTestIssuer } from "../secrets/issuer-test-server";
import { startModelGatewayFixture } from "./managed-pi-gateway";
import { buildPiStarterImages, piManagedTemplate } from "./managed-pi-images";
import { dockerCommand, serviceProbeImage } from "./service-image-fixture";

export const EGRESS_IMAGE =
  process.env.POCKETCODER_EGRESS_CONFORMANCE_IMAGE ??
  "ghcr.io/pufflyai/pocketcoder/egress@sha256:d94d1336f9aad317adc06f2cdb24082915efc1f654ead5e1baced06e72c39b29";
const ISSUER_SECRET = "model-gateway";

function freePort() {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = Number(server.port);
  server.stop(true);
  return port;
}

// A real controller with the Docker driver, restricted egress, a real HTTPS runtime issuer and the
// PC-135 Pi starter image. Nothing stands in for the driver: placement, launch, registration,
// credential leases and dispatch all run through the production owners.
export async function managedPiFixture(options: { queueCount?: number } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc-managed-pi-")));
  const issuer = await createTestIssuer({ directoryRoot: root });
  const gateway = startModelGatewayFixture((credential) => issuer.workspaceOf(credential));
  const images = await buildPiStarterImages(join(root, "images"));
  const caFile = join(root, "issuer-ca.pem");
  await writeFile(caFile, issuer.ca);
  const port = freePort();
  const agentPort = freePort();
  const logs: string[] = [];
  const env = {
    POCKETCODER_DIR: join(root, "data"),
    POCKETCODER_HTTP: `127.0.0.1:${port}`,
    POCKETCODER_AGENT_HTTP: `0.0.0.0:${agentPort}`,
    POCKETCODER_WORKSPACE_SERVER_URL: `http://host.docker.internal:${agentPort}`,
    POCKETCODER_STORAGE_BACKEND: "filesystem",
    POCKETCODER_WORKSPACE_DATA_DIR: join(root, "work"),
    POCKETCODER_CHECKPOINT_DIR: join(root, "checkpoints"),
    POCKETCODER_INPUT_DIR: join(root, "launch"),
    POCKETCODER_PRINCIPALS_FILE: join(root, "principals.json"),
    POCKETCODER_ISSUER_CA_FILE: caFile,
    POCKETCODER_EGRESS_IMAGE: EGRESS_IMAGE,
    POCKETCODER_MAX_ACTIVE_PER_PRINCIPAL: "40",
    POCKETCODER_SESSION_QUEUE: JSON.stringify({ count: options.queueCount ?? 8, bytes: 1048576 }),
    POCKETCODER_SESSION_EVENT_RETENTION: "1000",
    POCKETCODER_INPUT_STORAGE: JSON.stringify({
      root: join(root, "canonical"),
      projection: {
        root: join(root, "projection"),
        probeImage: serviceProbeImage,
        capacity: { bytes: 67108864, files: 1024 },
      },
      limits: {
        fileBytes: 1048576,
        stagedBytes: 8388608,
        files: 16,
        transfers: 2,
        transferMs: 30000,
        retentionMs: 600000,
      },
      principal: { bytes: 67108864, files: 1024 },
      instance: { bytes: 134217728, files: 2048 },
      headroom: { bytes: 1, files: 1 },
    }),
  };
  const template = await piManagedTemplate(images, gateway.port, ISSUER_SECRET);
  const tokenFile = join(root, "issuer.token"),
    keyFile = join(root, "consumer.token");
  await writeFile(tokenFile, issuer.authorization.slice(7));
  const configured = (
    limits = { workspacesPerOwner: 4, sessionsPerWorkspace: 4 },
    placement: "exclusive" | "shared" = "exclusive",
  ) => ({
    principals: [
      {
        name: "consumer",
        scopes: ["sessions:read", "sessions:write"],
        templates: [template.metadata.name],
        key: { target: { kind: "file", path: keyFile } },
        issuers: { [ISSUER_SECRET]: { url: issuer.url, tokenFile, policy: issuer.policy, revoke: false } },
        profiles: { chat: { template: template.metadata.name, issuer: ISSUER_SECRET, placement, limits } },
      },
    ],
  });
  await writeFile(env.POCKETCODER_PRINCIPALS_FILE, JSON.stringify(configured()));
  const start = async () => {
    const config = loadConfig({ ...env, POCKETCODER_WORKLOAD_LIMITS: JSON.stringify(template.spec.limits) });
    return startPocketCoderServer(config, { log: (line) => logs.push(line) });
  };
  let server = await start();
  const baseUrl = `http://127.0.0.1:${port}`;
  const owner = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      resolve(import.meta.dir, "../../../cli/src/index.ts"),
      "superuser",
      "create",
      "--dir",
      env.POCKETCODER_DIR,
      "--automation",
      "--expires",
      new Date(Date.now() + 3600000).toISOString(),
      "--json",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([
    new Response(owner.stdout).text(),
    new Response(owner.stderr).text(),
    owner.exited,
  ]);
  if (code) throw new Error(`Owner key creation failed: ${err}`);
  const issued = JSON.parse(out) as { token: string; key: { principal_id: string } };
  const admin = new PocketCoderClient({ baseUrl, apiKey: issued.token });
  const client = new PocketCoderClient({ baseUrl, apiKey: (await Bun.file(keyFile).text()).trim() });
  const http = async (path: string, method: string, body: unknown) => {
    const reply = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!reply.ok) throw new Error(`${method} ${path}: ${reply.status} ${await reply.text()}`);
    return reply.json();
  };
  const published = (await http("/v1/templates", "POST", { manifest: template })) as { digest: string };
  return {
    root,
    issuer,
    gateway,
    images,
    template,
    templateDigest: published.digest,
    client,
    admin,
    async configure(
      limits: { workspacesPerOwner: number; sessionsPerWorkspace: number },
      placement: "exclusive" | "shared" = "exclusive",
    ) {
      await writeFile(env.POCKETCODER_PRINCIPALS_FILE, JSON.stringify(configured(limits, placement)));
      const command = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          resolve(import.meta.dir, "../../../cli/src/index.ts"),
          "principals",
          "reconcile",
          "--dir",
          env.POCKETCODER_DIR,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const error = new Response(command.stderr).text();
      await new Response(command.stdout).text();
      if (await command.exited) throw new Error(await error);
      return "chat";
    },
    principalId: managedPrincipalId("consumer"),
    logs,
    async restart() {
      await server.stop();
      server = await start();
    },
    async stopController() {
      await server.stop();
    },
    async startController() {
      server = await start();
    },
    // Containers of this controller's workspaces only; other workspaces on the host are untouched.
    async containers() {
      return (await dockerCommand("ps", "-aq", "--filter", `label=pocketcoder.template-digest=${published.digest}`))
        .split(String.fromCharCode(10))
        .filter(Boolean);
    },
    async workspaceContainer(workspaceId: string) {
      return dockerCommand("ps", "-q", "--filter", `label=pocketcoder.workspace=${workspaceId}`);
    },
    async close() {
      const leftover = (
        await dockerCommand("ps", "-aq", "--filter", `label=pocketcoder.template-digest=${published.digest}`)
      ).split(String.fromCharCode(10));
      await server.stop();
      if (leftover.filter(Boolean).length) await dockerCommand("rm", "-f", ...leftover.filter(Boolean)).catch(() => {});
      gateway.stop();
      await issuer.close();
      await images.remove();
      await rm(root, { recursive: true, force: true });
    },
  };
}
