import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
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
    POCKETCODER_SECRET_KEY: randomBytes(32).toString("base64url"),
    POCKETCODER_ISSUER_CA_FILE: caFile,
    POCKETCODER_EGRESS_IMAGE: EGRESS_IMAGE,
    POCKETCODER_MAX_ACTIVE_PER_PRINCIPAL: "40",
    POCKETCODER_SESSION_QUEUE: JSON.stringify({ count: options.queueCount ?? 8, bytes: 1048576 }),
    POCKETCODER_SESSION_STOP_SECONDS: "60",
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
  const client = new PocketCoderClient({ baseUrl, apiKey: issued.token });
  const http = async (path: string, method: string, body: unknown) => {
    const reply = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!reply.ok) throw new Error(`${method} ${path}: ${reply.status} ${await reply.text()}`);
    return reply.json();
  };
  // The issuer configuration stays in the encrypted controller vault, never in a workspace.
  await http(`/v1/secrets/${ISSUER_SECRET}`, "PUT", {
    type: "runtime-issuer",
    value: { url: issuer.url, authorization: issuer.authorization, policy: issuer.policy },
  });
  const published = (await http("/v1/templates", "POST", { manifest: template })) as { digest: string };
  return {
    root,
    issuer,
    gateway,
    images,
    template,
    templateDigest: published.digest,
    client,
    principalId: issued.key.principal_id,
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
      const ids: string[] = [];
      for await (const workspace of client.workspaces.all())
        ids.push(
          ...(await dockerCommand("ps", "-aq", "--filter", `label=pocketcoder.workspace=${workspace.id}`)).split("\n"),
        );
      return ids.filter(Boolean);
    },
    async workspaceContainer(workspaceId: string) {
      return dockerCommand("ps", "-q", "--filter", `label=pocketcoder.workspace=${workspaceId}`);
    },
    async close() {
      const leftover: string[] = [];
      for await (const workspace of client.workspaces.all())
        leftover.push(
          ...(await dockerCommand("ps", "-aq", "--filter", `label=pocketcoder.workspace=${workspace.id}`)).split("\n"),
        );
      await server.stop();
      if (leftover.filter(Boolean).length) await dockerCommand("rm", "-f", ...leftover.filter(Boolean)).catch(() => {});
      gateway.stop();
      await issuer.close();
      await images.remove();
      await rm(root, { recursive: true, force: true });
    },
  };
}
