import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMemoryStorage } from "@pstdio/sdk/testing";
import { localInputEnvironment } from "../../../../examples/local/input-environment";
import { qualifySessionTemplate } from "../../../../examples/local/session-template";
import { type Api, PocketCoderError } from "./connection";
import { localProcess } from "./process-fixture";
import type { RunDeps } from "./runs";
import { readSettings } from "./settings";
import type { RunStorage } from "./storage";

const repo = resolve(import.meta.dir, "../../../..");

async function run(command: string[], cwd = repo, env: Record<string, string | undefined> = process.env) {
  const result = await localProcess.run({ command, cwd, env: env as Record<string, string> });
  if (result.exitCode) throw new Error(`${command.slice(0, 3).join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function freePort() {
  const listener = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => new Response() });
  const port = listener.port!;
  listener.stop(true);
  return port;
}

// Object storage the workspace reaches over plain HTTP, standing in for signed URLs.
function memoryStorage(): RunStorage & { stop(): void } {
  const objects = new Map<string, Blob>();
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    async fetch(request) {
      const object = decodeURIComponent(new URL(request.url).pathname.slice(1));
      if (request.method === "PUT") {
        objects.set(object, await request.blob());
        return new Response();
      }
      const archive = objects.get(object);
      return archive ? new Response(archive) : new Response("missing", { status: 404 });
    },
  });
  return {
    async exists(object) {
      return objects.has(object);
    },
    async upload(object, archive) {
      objects.set(object, new Blob([await archive.arrayBuffer()]));
    },
    async download(object) {
      const archive = objects.get(object);
      return archive ? await archive.bytes() : null;
    },
    async signedUrl(_method, object) {
      return `http://host.docker.internal:${server.port}/${encodeURIComponent(object)}`;
    },
    stop: () => server.stop(true),
  };
}

// A disposable Docker controller with the remote-tests template published.
export async function startController() {
  const root = await mkdtemp(join(tmpdir(), "remote-testing-"));
  const imageTag = `remote-testing:test-${randomUUID()}`;
  const operatorPort = freePort();
  const agentPort = freePort();
  const source = JSON.parse(await readFile(join(repo, "examples/harnesses/test-runner/template.json"), "utf8"));
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DOCKER_HOST: process.env.DOCKER_HOST,
    DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
    DOCKER_CONFIG: process.env.DOCKER_CONFIG,
    POCKETCODER_DIR: join(root, "data"),
    ...localInputEnvironment(root, source.spec.limits),
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
  const storage = memoryStorage();
  const stop = async () => {
    storage.stop();
    await cli("server", "stop").catch(() => {});
    await rm(root, { recursive: true, force: true });
    await run(["docker", "image", "rm", imageTag]).catch(() => {});
  };
  try {
    await run(["docker", "build", "-q", "-f", "examples/harnesses/test-runner/Dockerfile", "-t", imageTag, "."]);
    const digest = await run(["docker", "image", "inspect", imageTag, "--format", "{{.Id}}"]);
    await cli("server", "start");
    const { token } = JSON.parse(
      await cli(
        "superuser",
        "create",
        "--automation",
        "--expires",
        new Date(Date.now() + 3_600_000).toISOString(),
        "--json",
      ),
    );
    const api: Api = async (input) => {
      const response = await fetch(`http://127.0.0.1:${operatorPort}${input.path}`, {
        method: input.method,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...input.headers },
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal: input.signal,
      });
      const body = await response.json();
      if (!response.ok) throw new PocketCoderError(response.status, JSON.stringify(body));
      return body as never;
    };
    const template = await qualifySessionTemplate(source, `${imageTag}@${digest}`);
    template.spec.limits = source.spec.limits;
    await api({ method: "POST", path: "/v1/templates", body: { manifest: template as never } });
    const { settings } = readSettings({
      templateVersion: template.spec.version,
      testCommand: "true",
      storageBucket: "memory",
      signerAccount: "memory",
    });
    const logs = join(root, "logs");
    const deps: RunDeps = {
      api,
      storage,
      store: createMemoryStorage(),
      process: localProcess,
      settings,
      async saveResults(runId, bytes) {
        const path = join(logs, `${runId}.tar.gz`);
        await Bun.write(path, bytes);
        return path;
      },
      async saveLog(runId, text) {
        const path = join(logs, `${runId}.log`);
        await Bun.write(path, text);
        return path;
      },
    };
    return { deps, root, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
