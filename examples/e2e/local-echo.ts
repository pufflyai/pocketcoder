import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  HEADER_PROTOCOL,
  HEADER_REGISTRATION,
  HEADER_WORKSPACE,
  PROTOCOL_VERSION,
  parseTemplateManifest,
} from "@pstdio/pocketcoder-contracts";
import { buildLocalImage } from "../local/runtime";
import { createHarnessWorkspace, type ReadyHarnessWorkspace } from "./contract";
import { messageList, responseText } from "./contract-messages";
import { bestEffort, command, freePort, waitFor } from "./local-process";

const root = resolve(import.meta.dir, "../..");
const directory = await mkdtemp(join(tmpdir(), "pocketcoder-local-echo-"));
const dataDir = join(directory, "pc_data");
const inputs = join(directory, "inputs");
const templateDir = join(directory, "templates");
const imageTag = `pocketcoder-local-echo:${randomUUID()}`;
const operatorPort = freePort();
const agentPort = freePort();
const baseUrl = `http://127.0.0.1:${operatorPort}`;
const cli = ["bun", "--no-env-file", "packages/cli/src/index.ts"];
const controllerEnv = {
  POCKETCODER_TEMPLATE_DIR: undefined,
  POCKETCODER_DIR: dataDir,
  POCKETCODER_HTTP: `127.0.0.1:${operatorPort}`,
  POCKETCODER_AGENT_HTTP: `0.0.0.0:${agentPort}`,
  POCKETCODER_WORKSPACE_SERVER_URL: `http://host.docker.internal:${agentPort}`,
  POCKETCODER_INPUT_DIR: inputs,
  POCKETCODER_SECRET_PROVIDER: "disabled",
  POCKETCODER_STORAGE_BACKEND: "disabled",
  POCKETCODER_WARM_POOLS: "[]",
};
let controller: ReturnType<typeof Bun.spawn> | undefined;
let controllerOutput: Promise<string[]> | undefined;
let workspace: ReadyHarnessWorkspace | undefined;
let capturing = false;

async function captureInput() {
  const deadline = Date.now() + 120_000;
  while (capturing && Date.now() < deadline) {
    const files = await readdir(inputs).catch(() => []);
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      const content = await readFile(join(inputs, file), "utf8").catch(() => "");
      try {
        const parsed = JSON.parse(content);
        if (parsed.registration_secret)
          return parsed as { workspace_id: string; server_url: string; registration_secret: string };
      } catch {
        // The driver may still be writing the input file.
      }
    }
    await Bun.sleep(5);
  }
  throw new Error("Workspace registration input was not captured");
}

async function start() {
  controller = Bun.spawn([...cli, "serve", "--dir", dataDir], {
    cwd: root,
    env: { ...process.env, ...controllerEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  controllerOutput = Promise.all([new Response(controller.stdout).text(), new Response(controller.stderr).text()]);
  await waitFor(
    async () => {
      if (controller?.exitCode !== null) throw new Error(`Controller exited: ${(await controllerOutput)?.join("\n")}`);
      return fetch(`${baseUrl}/readyz`)
        .then((response) => response.ok)
        .catch(() => false);
    },
    30_000,
    "local controller",
  );
}

async function stop() {
  if (!controller) return;
  controller.kill("SIGTERM");
  const code = await controller.exited;
  const output = await controllerOutput;
  controller = undefined;
  if (code !== 0) throw new Error(`Controller stop failed (${code}): ${output?.join("\n")}`);
}

const keyNames = ["auth-pepper", "event-signing-key", "secret-key"];
async function identity() {
  return Promise.all(
    keyNames.map(async (name) =>
      createHash("sha256")
        .update(await readFile(join(dataDir, "keys", name)))
        .digest("hex"),
    ),
  );
}

try {
  await command(
    ["bun", "build", "packages/supervisor/src/index.ts", "--target", "bun", "--outdir", "deploy/image/dist"],
    { quiet: true },
  );
  const image = await buildLocalImage({ root, imageTag, context: "deploy/image", command });
  const source = JSON.parse(await readFile(join(root, "examples/harnesses/echo/template.json"), "utf8"));
  source.spec.image = image.image;
  const template = parseTemplateManifest(source);
  await mkdir(templateDir);
  await writeFile(join(templateDir, "echo.json"), JSON.stringify(template.manifest));
  await start();
  console.log("Empty controller started; operator and agent ports are separate.");
  const expires = new Date(Date.now() + 60 * 60_000).toISOString();
  const ownerArgs = [
    ...cli,
    "superuser",
    "create",
    "--dir",
    dataDir,
    "--automation",
    "--expires",
    expires,
    "--request-id",
    randomUUID(),
    "--json",
  ];
  const owner = JSON.parse((await command(ownerArgs, { quiet: true })).stdout);
  if (!owner.token || owner.key.expires_at !== expires) throw new Error("Missing finite owner key");
  if (JSON.parse((await command(ownerArgs, { quiet: true })).stdout).token !== null)
    throw new Error("Owner plaintext returned twice");
  console.log(`Finite owner issued once; expiry ${expires}.`);
  const env = { POCKETCODER_URL: baseUrl, POCKETCODER_KEY: owner.token };
  await command([...cli, "templates", "import", templateDir], { env });
  capturing = true;
  const capturedInput = captureInput();
  // Observe the driver input before successful registration removes it.
  capturedInput.catch(() => {});
  workspace = await createHarnessWorkspace({ baseUrl, key: owner.token, template: "echo-harness" });
  const input = await capturedInput;
  capturing = false;
  const workspaceId = workspace.workspaceId;
  if (input.workspace_id !== workspaceId || input.server_url !== controllerEnv.POCKETCODER_WORKSPACE_SERVER_URL)
    throw new Error("Wrong agent callback or workspace identity");
  const containerName = `pocketcoder-ws-${workspaceId}`;
  const inspect = JSON.parse((await command(["docker", "inspect", containerName], { quiet: true })).stdout)[0];
  const keys = await Promise.all(keyNames.map((name) => readFile(join(dataDir, "keys", name))));
  const accessible = JSON.stringify({ environment: inspect.Config.Env, input });
  if ([owner.token, ...keys.map((key) => key.toString("base64url"))].some((key) => accessible.includes(key)))
    throw new Error("Controller authority reached workspace");
  if (
    inspect.Mounts.some(
      (mount: { Source: string; Destination: string }) =>
        mount.Source.startsWith(dataDir) || mount.Destination.includes("docker.sock"),
    )
  )
    throw new Error("Controller data or Docker socket reached workspace");
  console.log(`Workspace ${workspaceId} ready; controller credentials stay outside it.`);
  const prompt = `hello ${randomUUID()}`;
  const sent = await workspace.request(`/v1/workspaces/${workspaceId}/agent/message`, {
    method: "POST",
    body: JSON.stringify({ type: "user", content: prompt }),
  });
  if (!sent.ok) throw new Error(`Message failed: ${await sent.text()}`);
  let reply = "";
  await waitFor(
    async () => {
      const response = await workspace?.request(`/v1/workspaces/${workspaceId}/agent/messages`);
      reply = responseText(messageList(await response?.json()), 0);
      return reply === `echo: ${prompt}`;
    },
    60_000,
    "echo response",
  );
  console.log(reply);
  const terminalState = await workspace.cancel();
  workspace = undefined;
  if (terminalState !== "canceled") throw new Error(`Unexpected terminal state ${terminalState}`);
  if ((await command(["docker", "ps", "-aq", "--filter", `name=^/${containerName}$`], { quiet: true })).stdout)
    throw new Error("Container survived teardown");
  const denied = await fetch(`http://127.0.0.1:${agentPort}/v1/agent/connect`, {
    headers: {
      [HEADER_WORKSPACE]: workspaceId,
      [HEADER_REGISTRATION]: input.registration_secret,
      [HEADER_PROTOCOL]: String(PROTOCOL_VERSION),
    },
  });
  if (denied.status !== 401) throw new Error("Completed registration remains usable");
  const before = await identity();
  await stop();
  await start();
  if (JSON.stringify(before) !== JSON.stringify(await identity())) throw new Error("Controller identity changed");
  const catalog = JSON.parse((await command([...cli, "templates", "list", "--json"], { env, quiet: true })).stdout);
  if (!catalog.some((row: { digest: string }) => row.digest === template.digest))
    throw new Error("Template lost on restart");
  console.log(
    JSON.stringify(
      {
        result: "passed",
        workspaceId,
        terminalState,
        image: image.image,
        templateDigest: template.digest,
        controllerIdentity: before,
        registrationAfterTeardown: denied.status,
        restarted: true,
        runtimeLease: "not needed by credential-free echo",
      },
      null,
      2,
    ),
  );
} finally {
  capturing = false;
  await workspace?.cancel().catch(() => {});
  await stop();
  await bestEffort(["docker", "image", "rm", "--force", imageTag]);
  await rm(directory, { recursive: true, force: true });
}
