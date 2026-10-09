import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { loadConfig } from "@pstdio/pocketcoder-server/config";
import { startPocketCoderServer } from "@pstdio/pocketcoder-server/lifecycle";
import { buildLocalImage } from "../local/runtime";
import { createHarnessWorkspace, type ReadyHarnessWorkspace } from "./contract";
import { messageList, responseText } from "./contract-messages";
import { bestEffort, command, freePort, waitFor } from "./local-process";

const registryImage = "registry:2@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373";
const root = resolve(import.meta.dir, "../..");
const directory = await realpath(await mkdtemp(join(tmpdir(), "pc-private-image-")));
const dataDir = join(directory, "pc_data");
const suffix = randomUUID();
const registryName = `pc-private-registry-${suffix}`;
const imageTag = `pc-private-echo:${suffix}`;
const credential = { server: `127.0.0.1:${freePort()}`, username: "synthetic", password: randomUUID() };
const remoteTag = `${credential.server}/echo:${suffix}`;
const agentPort = freePort();
const logs: string[] = [];
let running: Awaited<ReturnType<typeof startPocketCoderServer>> | undefined;
let workspace: ReadyHarnessWorkspace | undefined;

try {
  await writeFile(
    join(directory, "htpasswd"),
    `${credential.username}:${await Bun.password.hash(credential.password, { algorithm: "bcrypt", cost: 4 })}\n`,
    { mode: 0o600 },
  );
  await command(
    [
      "docker",
      "run",
      "-d",
      "--name",
      registryName,
      "--network",
      "host",
      "--mount",
      `type=bind,src=${directory}/htpasswd,dst=/auth/htpasswd,readonly`,
      "-e",
      `REGISTRY_HTTP_ADDR=0.0.0.0:${credential.server.split(":")[1]}`,
      "-e",
      "REGISTRY_AUTH=htpasswd",
      "-e",
      "REGISTRY_AUTH_HTPASSWD_REALM=pc-test",
      "-e",
      "REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd",
      registryImage,
    ],
    { quiet: true },
  );
  await waitFor(
    async () => {
      try {
        await command(
          [
            "docker",
            "exec",
            registryName,
            "sh",
            "-c",
            `wget -S --spider http://${credential.server}/v2/ 2>&1 | grep -q '401 Unauthorized'`,
          ],
          { quiet: true },
        );
        return true;
      } catch {
        return false;
      }
    },
    10_000,
    "authenticated registry",
  );
  await command(
    ["bun", "build", "packages/supervisor/src/index.ts", "--target", "bun", "--outdir", "deploy/image/dist"],
    { quiet: true },
  );
  await buildLocalImage({ root, imageTag, context: "deploy/image", command });
  await command(["docker", "tag", imageTag, remoteTag], { quiet: true });
  // This synthetic push configuration stays outside the workspace and dies with the registry.
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({
      auths: {
        [credential.server]: { auth: Buffer.from(`${credential.username}:${credential.password}`).toString("base64") },
      },
    }),
    { mode: 0o600 },
  );
  await command(["docker", "--config", directory, "push", remoteTag], { quiet: true });
  await rm(join(directory, "config.json"));
  const image = JSON.parse(
    (await command(["docker", "image", "inspect", remoteTag], { quiet: true })).stdout,
  )[0].RepoDigests.find((value: string) => value.startsWith(`${credential.server}/echo@`)) as string;
  if (!image) throw new Error("Private image has no pinned registry digest");
  running = await startPocketCoderServer(
    {
      ...loadConfig({ POCKETCODER_DIR: dataDir }),
      listenHost: "127.0.0.1",
      listenPort: 0,
      agentPort,
      inputDir: join(directory, "inputs"),
      workspaceServerUrl: `http://host.docker.internal:${agentPort}`,
    },
    { log: (line) => logs.push(line) },
  );
  const cli = ["bun", "--no-env-file", "packages/cli/src/index.ts"];
  const owner = JSON.parse(
    (
      await command(
        [
          ...cli,
          "superuser",
          "create",
          "--dir",
          dataDir,
          "--automation",
          "--expires",
          new Date(Date.now() + 300_000).toISOString(),
          "--request-id",
          randomUUID(),
          "--json",
        ],
        { quiet: true },
      )
    ).stdout,
  );
  const env = { POCKETCODER_URL: running.url, POCKETCODER_KEY: owner.token };
  const secretFile = join(directory, "registry.json");
  await writeFile(secretFile, JSON.stringify({ type: "registry", value: credential }), { mode: 0o600 });
  const stored = await command([...cli, "secrets", "put", "private-echo", "--file", secretFile], { env, quiet: true });
  await rm(secretFile);
  if (stored.stdout.includes(credential.password)) throw new Error("CLI exposed registry authority");
  const client = new PocketCoderClient({ baseUrl: running.url, apiKey: owner.token });
  const manifest = JSON.parse(await readFile(join(root, "examples/harnesses/echo/template.json"), "utf8"));
  manifest.spec.image = image;
  manifest.spec.imagePullSecret = "secretRef:private-echo";
  await client.templates.publish(manifest);
  workspace = await createHarnessWorkspace({ baseUrl: running.url, key: owner.token, template: "echo-harness" });
  const name = `pocketcoder-ws-${workspace.workspaceId}`;
  const inspected = await command(["docker", "inspect", name], { quiet: true });
  if (inspected.stdout.includes(credential.password) || inspected.stdout.includes(dataDir))
    throw new Error("Controller authority reached the workspace");
  const prompt = `private ${suffix}`;
  const sent = await workspace.request(`/v1/workspaces/${workspace.workspaceId}/agent/message`, {
    method: "POST",
    body: JSON.stringify({ type: "user", content: prompt }),
  });
  if (!sent.ok) throw new Error("Private workspace message failed");
  await waitFor(
    async () => {
      const reply = await workspace?.request(`/v1/workspaces/${workspace.workspaceId}/agent/messages`);
      return responseText(messageList(await reply?.json()), 0) === `echo: ${prompt}`;
    },
    30_000,
    "private echo reply",
  );
  const workspaceId = workspace.workspaceId;
  await workspace.cancel();
  workspace = undefined;
  await client.secrets.retire("private-echo");
  if (logs.join("\n").includes(credential.password)) throw new Error("Logs exposed registry authority");
  console.log(JSON.stringify({ result: "passed", workspaceId, image, reply: `echo: ${prompt}`, retired: true }));
} finally {
  await workspace?.cancel().catch(() => {});
  await running?.stop();
  await bestEffort(["docker", "rm", "--force", "--volumes", registryName]);
  await bestEffort(["docker", "image", "rm", "--force", remoteTag, imageTag]);
  await rm(directory, { recursive: true, force: true });
}
