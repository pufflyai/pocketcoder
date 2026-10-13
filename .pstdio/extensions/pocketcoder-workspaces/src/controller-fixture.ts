import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionConnectionsApi } from "@pstdio/sdk/extensions";
import { createMemoryStorage, makeCommandContext } from "@pstdio/sdk/testing";

const repo = resolve(import.meta.dir, "../../../..");
async function run(args: string[], cwd = repo, env: Record<string, string | undefined> = process.env) {
  const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) throw new Error(`Command failed: ${args[0]} ${args[1]}: ${stderr}`);
  return stdout.trim();
}
function freePort() {
  const listener = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => new Response() });
  const port = listener.port;
  if (!port) throw new Error("Missing TCP port");
  listener.stop(true);
  return port;
}

export async function startController() {
  const root = await mkdtemp(join(tmpdir(), "pc-workspaces-"));
  const imageTag = `pocketcoder-workspaces:test-${randomUUID()}`;
  const operatorPort = freePort();
  let agentPort = freePort();
  while (operatorPort === agentPort) agentPort = freePort();
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DOCKER_HOST: process.env.DOCKER_HOST,
    DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
    DOCKER_CONFIG: process.env.DOCKER_CONFIG,
    POCKETCODER_DIR: join(root, "data"),
    POCKETCODER_STATE_DIR: join(root, "state"),
    POCKETCODER_HTTP: `127.0.0.1:${operatorPort}`,
    POCKETCODER_AGENT_HTTP: `0.0.0.0:${agentPort}`,
    POCKETCODER_WORKSPACE_SERVER_URL: `http://host.docker.internal:${agentPort}`,
    POCKETCODER_STORAGE_BACKEND: "filesystem",
    POCKETCODER_WORKSPACE_DATA_DIR: join(root, "workspaces"),
    POCKETCODER_CHECKPOINT_DIR: join(root, "checkpoints"),
  };
  await writeFile(join(root, "empty.env"), "");
  const cli = (...args: string[]) =>
    run([join(repo, "out/native/pocketcoder"), "--env-file", "empty.env", ...args], root, env);
  const stop = async () => {
    await cli("server", "stop");
    await rm(root, { recursive: true, force: true });
    await run(["docker", "image", "rm", imageTag]);
  };
  try {
    await run(["bun", "build", "packages/supervisor/src/index.ts", "--target", "bun", "--outdir", "deploy/image/dist"]);
    await run(["docker", "build", "-t", imageTag, "deploy/image"]);
    const digest = await run(["docker", "image", "inspect", imageTag, "--format", "{{.Id}}"]);
    await cli("server", "start");
    const issued = JSON.parse(
      await cli(
        "superuser",
        "create",
        "--automation",
        "--expires",
        new Date(Date.now() + 600_000).toISOString(),
        "--json",
      ),
    );
    const requests: { method: string; path: string; body: unknown; key?: string }[] = [];
    const request: ExtensionConnectionsApi["request"] = async <T>(
      _id: string,
      input: Parameters<ExtensionConnectionsApi["request"]>[1],
    ) => {
      requests.push({
        method: input.method,
        path: input.path,
        body: input.body,
        key: input.headers?.["Idempotency-Key"],
      });
      const response = await fetch(`http://127.0.0.1:${operatorPort}${input.path}`, {
        method: input.method,
        headers: { "content-type": "application/json", authorization: `Bearer ${issued.token}`, ...input.headers },
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal: input.signal,
      });
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: (await response.json()) as T,
      };
    };
    const template = JSON.parse(await readFile(join(repo, "examples/harnesses/echo/template.json"), "utf8"));
    template.spec.image = `${imageTag}@${digest}`;
    const published = await request("pocketcoder", {
      method: "POST",
      path: "/v1/templates",
      body: { manifest: template },
    });
    if (published.status !== 201 && published.status !== 200) throw new Error("Could not publish test template.");
    const settings = { templateName: template.metadata.name, templateVersion: template.spec.version };
    const state = createMemoryStorage();
    const ctx = makeCommandContext({
      storage: createMemoryStorage(),
      params: {},
      projectId: randomUUID(),
      overrides: {
        extensionId: "pocketcoder.pocketcoder-workspaces",
        connections: { request },
        settings: { all: async () => settings },
        logger: { warn() {}, info() {}, error() {} },
      },
    });
    return { ctx, harnessCtx: { ...ctx, state }, settings, template, requests, request, stop };
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
}
