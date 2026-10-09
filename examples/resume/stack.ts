import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { loadConfig } from "@pstdio/pocketcoder-server/config";
import { startPocketCoderServer } from "@pstdio/pocketcoder-server/lifecycle";
import { bootstrapExampleOwner, issueExampleAccess } from "../e2e/administration";
import { freePort } from "../e2e/local-process";
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
    console.log("Building the remote client...");
    await this.run(["bun", "run", "build"]);
    console.log("Building the Pi workspace image...");
    const imageTag = `pocketcoder-resume-pi:${id}`;
    this.cleanups.push(() => run(["docker", "image", "rm", "--force", imageTag]));
    const { image } = await buildLocalImage({
      root: ROOT,
      imageTag,
      context: ".",
      dockerfile: "examples/harnesses/pi/Dockerfile",
      command: (args) => this.run(args),
    });
    const adminEnv = {
      POCKETCODER_DIR: join(directory, "pc_data"),
      POCKETCODER_AUTH_PEPPER: randomBytes(32).toString("base64url"),
    };
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    // Cleanup authority stays in this host process after model access ends.
    const cleanupExpiresAt = new Date(expiresAt.getTime() + 5 * 60 * 1000);
    const ownerKey = await bootstrapExampleOwner(
      adminEnv.POCKETCODER_DIR,
      adminEnv.POCKETCODER_AUTH_PEPPER,
      cleanupExpiresAt,
    );
    const templates = join(directory, "templates");
    await mkdir(templates);
    await Bun.write(join(templates, "pi-resume.json"), JSON.stringify(resumeTemplate(image, idleSeconds)));
    const serverPort = freePort();
    const agentPort = freePort();
    const logFile = Bun.file(join(directory, "server.log")).writer();
    this.cleanups.push(async () => {
      await logFile.end();
    });
    const server = await startPocketCoderServer(
      loadConfig({
        ...adminEnv,
        POCKETCODER_HOST: "0.0.0.0",
        POCKETCODER_PORT: String(serverPort),
        POCKETCODER_AGENT_HTTP: `0.0.0.0:${agentPort}`,
        POCKETCODER_TEMPLATE_DIR: templates,
        POCKETCODER_INPUT_DIR: join(directory, "inputs"),
        POCKETCODER_WORKSPACE_SERVER_URL: `http://host.docker.internal:${agentPort}`,
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
    const key = await issueExampleAccess(baseUrl, ownerKey, {
      name: id,
      scopes: [
        ...LOCAL_PI_PRINCIPAL_SCOPES,
        "workspaces:preserve",
        "workspaces:restore",
        "checkpoints:read",
        "checkpoints:delete",
      ],
      templates: ["pi-resume"],
      expiresAt: cleanupExpiresAt,
    });
    const client = new PocketCoderClient({ baseUrl, apiKey: key });
    console.log(`Isolated API: ${baseUrl}`);
    console.log(`Temporary storage: ${directory}`);
    return { client, baseUrl, key, directory, expiresAt };
  }
}
