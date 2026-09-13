import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { loadConfig } from "@pstdio/pocketcoder-server/config";
import { startPocketCoderServer } from "@pstdio/pocketcoder-server/lifecycle";
import { freePort, waitFor } from "../e2e/local-process";
import { LOCAL_PI_PRINCIPAL_SCOPES } from "../local/options";
import { buildLocalImage } from "../local/runtime";
import { removeRunDirectory } from "./cleanup";
import { isolatedEnvironment } from "./environment";
import { resumeTemplate } from "./template";

export const ROOT = resolve(import.meta.dir, "../..");

export async function run(args: string[], env: Record<string, string> = {}, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const child = Bun.spawn(args, {
    cwd: ROOT,
    env: { ...isolatedEnvironment(), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const abort = () => child.kill("SIGTERM");
  signal?.addEventListener("abort", abort, { once: true });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  signal?.removeEventListener("abort", abort);
  signal?.throwIfAborted();
  if (code !== 0) throw new Error(`${args[0]} ${args[1]} failed: ${stderr.slice(-4000)}`);
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

export class IsolatedStack {
  private readonly setup = new AbortController();
  private run(args: string[], env: Record<string, string> = {}) {
    return run(args, env, this.setup.signal);
  }
  readonly cleanups: Array<() => Promise<unknown>> = [];
  async close() {
    this.setup.abort(new Error("Isolated startup stopped"));
    const failures: unknown[] = [];
    for (const cleanup of this.cleanups.reverse()) {
      await cleanup().catch((error) => failures.push(error));
    }
    if (failures.length) throw new AggregateError(failures, "Isolated run cleanup failed");
  }

  async start(idleSeconds: number) {
    const directory = await mkdtemp(join(tmpdir(), "pocketcoder-resume-"));
    this.cleanups.push(() => removeRunDirectory(directory));
    const id = randomBytes(6).toString("hex");
    const postgres = `pocketcoder-resume-db-${id}`;
    console.log("Building the remote client and Pi workspace image...");
    await this.run(["bun", "run", "build"]);
    const imageTag = `pocketcoder-resume-pi:${id}`;
    this.cleanups.push(() => run(["docker", "image", "rm", "--force", imageTag]));
    const { image } = await buildLocalImage({
      root: ROOT,
      imageTag,
      context: ".",
      dockerfile: "examples/harnesses/pi/Dockerfile",
      command: (args) => this.run(args),
    });
    this.cleanups.push(() => run(["docker", "rm", "--force", postgres]));
    await this.run([
      "docker",
      "run",
      "--detach",
      "--name",
      postgres,
      "--env",
      "POSTGRES_USER=pocketcoder",
      "--env",
      "POSTGRES_PASSWORD=pocketcoder",
      "--env",
      "POSTGRES_DB=pocketcoder",
      "--publish",
      "127.0.0.1::5432",
      "postgres:16-alpine",
    ]);
    const port = (await this.run(["docker", "port", postgres, "5432/tcp"])).stdout
      .split(":")
      .at(-1);
    await waitFor(
      async () => {
        try {
          await this.run([
            "docker",
            "exec",
            postgres,
            "pg_isready",
            "-h",
            "127.0.0.1",
            "-U",
            "pocketcoder",
          ]);
          return true;
        } catch {
          return false;
        }
      },
      30_000,
      "isolated PostgreSQL",
    );
    const adminEnv = {
      POCKETCODER_DATABASE_URL: `postgres://pocketcoder:pocketcoder@127.0.0.1:${port}/pocketcoder`,
      POCKETCODER_DATABASE_SCHEMA: "pocketcoder",
      POCKETCODER_AUTH_PEPPER: randomBytes(32).toString("base64url"),
    };
    await Bun.write(join(directory, ".env"), "");
    const cli = [
      "bun",
      "--no-env-file",
      "packages/cli/src/index.ts",
      "--env-file",
      join(directory, ".env"),
    ];
    await this.run([...cli, "db", "migrate"], adminEnv);
    await this.run(
      [
        ...cli,
        "principals",
        "create",
        "--name",
        id,
        "--scopes",
        [
          ...LOCAL_PI_PRINCIPAL_SCOPES,
          "workspaces:preserve",
          "workspaces:restore",
          "checkpoints:read",
          "checkpoints:delete",
        ].join(","),
        "--templates",
        "pi-resume",
      ],
      adminEnv,
    );
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    // The host still needs authority to cancel workspaces and delete checkpoints
    // after model access ends. This key never enters a workspace.
    const cleanupExpiresAt = new Date(expiresAt.getTime() + 5 * 60 * 1000);
    const issued = await this.run(
      [...cli, "keys", "issue", "--principal", id, "--expires", cleanupExpiresAt.toISOString()],
      adminEnv,
    );
    const key = issued.stdout.split("\n").find((line) => line.startsWith("pkt_"));
    if (!key) throw new Error("Machine key was not issued");
    const templates = join(directory, "templates");
    await mkdir(templates);
    await Bun.write(
      join(templates, "pi-resume.json"),
      JSON.stringify(resumeTemplate(image, idleSeconds)),
    );
    const serverPort = freePort();
    const logFile = Bun.file(join(directory, "server.log")).writer();
    this.cleanups.push(async () => {
      await logFile.end();
    });
    const server = await startPocketCoderServer(
      loadConfig({
        ...adminEnv,
        POCKETCODER_HOST: "0.0.0.0",
        POCKETCODER_PORT: String(serverPort),
        POCKETCODER_TEMPLATE_DIR: templates,
        POCKETCODER_INPUT_DIR: join(directory, "inputs"),
        POCKETCODER_WORKSPACE_SERVER_URL: `http://host.docker.internal:${serverPort}`,
        POCKETCODER_STORAGE_BACKEND: "filesystem",
        POCKETCODER_WORKSPACE_DATA_DIR: join(directory, "workspaces"),
        POCKETCODER_CHECKPOINT_DIR: join(directory, "checkpoints"),
      }),
      {
        log: (message) => {
          void logFile.write(`${message}\n`);
        },
      },
    );
    this.cleanups.push(() => server.stop());
    const baseUrl = `http://127.0.0.1:${serverPort}`;
    const client = new PocketCoderClient({ baseUrl, apiKey: key });
    console.log(`Isolated API: ${baseUrl}`);
    console.log(`Temporary storage: ${directory}`);
    return { client, baseUrl, key, directory, expiresAt };
  }
}
