import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTemplateManifest, snapshotOf } from "@pstdio/pocketcoder-contracts";
import type { ProviderRef, WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
import { DockerDriver } from "./docker";
import { runDocker } from "./docker-command";
import { pullPrivateImage } from "./docker-registry";
import { localDockerSocket, registryImageRequest } from "./docker-registry-client";

const registryImage = "registry:2@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373";
const controllerId = randomUUID();
const driver = new DockerDriver({ addHostGateway: false, resolveRegistry: async () => credential });
let directory: string;
let registryId: string;
let image: string;
let ref: ProviderRef | undefined;
let credential = { server: "", username: "pc-test", password: "synthetic-registry-test!" };

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "pc-registry-test-"));
  const passwordFile = `${credential.username}:${await Bun.password.hash(credential.password, { algorithm: "bcrypt", cost: 4 })}\n`;
  await writeFile(join(directory, "htpasswd"), passwordFile, { mode: 0o600 });
  const port = 40000 + Math.floor(Math.random() * 20000);
  credential = { ...credential, server: `127.0.0.1:${port}` };
  registryId = await runDocker("docker", [
    "run",
    "-d",
    "--name",
    `pc-registry-${controllerId}`,
    "--network",
    "host",
    "--mount",
    `type=bind,src=${directory},dst=/auth,readonly`,
    "-e",
    `REGISTRY_HTTP_ADDR=127.0.0.1:${port}`,
    "-e",
    "REGISTRY_AUTH=htpasswd",
    "-e",
    "REGISTRY_AUTH_HTPASSWD_REALM=pc-test",
    "-e",
    "REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd",
    registryImage,
  ]);
  const tagged = `${credential.server}/workspace:${controllerId}`;
  await runDocker("docker", ["tag", registryImage, tagged]);
  const digest = await registryImageRequest(
    await localDockerSocket("docker"),
    `/images/${encodeURIComponent(`${credential.server}/workspace`)}/push?${new URLSearchParams({ tag: controllerId })}`,
    credential,
  );
  if (!digest) throw new Error("Private image digest missing");
  image = `${credential.server}/workspace@${digest}`;
}, 15_000);

afterAll(async () => {
  if (ref) await driver.remove(ref);
  if (registryId) {
    await runDocker("docker", ["rm", "--force", "--volumes", registryId]);
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("private registry pull uses controller credentials without exposing them to the runtime", async () => {
  await expect(pullPrivateImage("docker", image, { ...credential, password: "wrong" })).rejects.toThrow(
    "Private workspace image pull failed",
  );
  const template = snapshotOf(
    parseTemplateManifest({
      apiVersion: "pocketcoder.dev/v1alpha1",
      kind: "Template",
      metadata: { name: "private-image" },
      spec: {
        version: "1.0.0",
        image,
        imagePullSecret: "secretRef:pull-image",
        command: ["sh", "-c", "sleep 60"],
        agent: { command: ["true"] },
        resources: { cpu: "1", memory: "128Mi" },
      },
    }),
  );
  const id = randomUUID();
  const input = {
    server_url: "http://localhost:8091",
    workspace_id: id,
    registration_secret: "one-use",
    template_digest: template.digest,
    template_name: template.name,
    template_version: template.version,
    launch_mode: "create" as const,
  };
  ref = await driver.create({
    workspace: {
      id,
      templateDigest: template.digest,
      templateSnapshot: template,
      deadlineAt: new Date(Date.now() + 60_000),
    } as WorkspaceRow,
    input,
    mounts: [],
    secrets: [],
  });
  const inspect = await runDocker("docker", ["inspect", ref.id]);
  expect(inspect).not.toContain(credential.password);
  expect(inspect).not.toContain("pocketcoder-registry-");
  expect(await runDocker("docker", ["exec", ref.id, "cat", "/run/pocketcoder/input"])).not.toContain(
    credential.password,
  );
  await driver.remove(ref);
  ref = undefined;
}, 15_000);

test("abrupt pull client death leaves no recoverable registry credentials on disk", async () => {
  const clientTemp = await mkdtemp(join(tmpdir(), "pc-registry-client-"));
  await runDocker("docker", ["pause", registryId]);
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--eval",
      `import { pullPrivateImage } from "./packages/drivers/src/docker/docker-registry.ts";
     const { image, credential } = JSON.parse(await Bun.stdin.text());
     console.log("pull-started");
     await pullPrivateImage("docker", image, credential);
     console.log("pull-finished");`,
    ],
    { env: { ...process.env, TMPDIR: clientTemp }, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  child.stdin.write(JSON.stringify({ image, credential }));
  child.stdin.end();
  const reader = child.stdout.getReader();
  try {
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("pull-started");
    await Bun.sleep(500);
    expect(child.exitCode).toBeNull();
    child.kill("SIGKILL");
    await child.exited;
    expect(await readdir(clientTemp)).toEqual([]);
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    reader.releaseLock();
    await runDocker("docker", ["unpause", registryId]);
    await rm(clientTemp, { recursive: true, force: true });
  }
}, 15_000);

test("private pulls honor context precedence and refuse remote daemons and mutable tags", async () => {
  const socket = await localDockerSocket("docker");
  const context = `pc-registry-${controllerId}`;
  await runDocker("docker", ["context", "create", context, "--docker", `host=unix://${socket}`]);
  async function pull(env: Record<string, string | undefined>, selectedImage = image) {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--eval",
        `import { pullPrivateImage } from "./packages/drivers/src/docker/docker-registry.ts";
       const { image, credential } = JSON.parse(await Bun.stdin.text());
       try { await pullPrivateImage("docker", image, credential); }
       catch (error) { console.error(error.message); process.exit(1); }`,
      ],
      { env: { ...process.env, ...env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    child.stdin.write(JSON.stringify({ image: selectedImage, credential }));
    child.stdin.end();
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    return { code, error: error.trim() };
  }
  try {
    expect(await pull({ DOCKER_CONTEXT: context, DOCKER_HOST: "unix:///unreachable-pc-registry.sock" })).toEqual({
      code: 0,
      error: "",
    });
    expect((await pull({ DOCKER_CONTEXT: undefined, DOCKER_HOST: `unix://${socket}` })).code).toBe(0);
    expect(await pull({ DOCKER_CONTEXT: undefined, DOCKER_HOST: "tcp://127.0.0.1:9" })).toEqual({
      code: 1,
      error: "Private workspace pulls require a local Docker socket",
    });
    expect(
      await pull({ DOCKER_CONTEXT: "missing-pc-registry-context" }, `${credential.server}/workspace:latest`),
    ).toEqual({
      code: 1,
      error: "Private workspace images require a pinned digest",
    });
    expect(await pull({ DOCKER_CONTEXT: "missing-pc-registry-context" }, `@sha256:${"a".repeat(64)}`)).toEqual({
      code: 1,
      error: "Private workspace images require a pinned digest",
    });
  } finally {
    await runDocker("docker", ["context", "rm", "--force", context]);
  }
}, 15_000);
