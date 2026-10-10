import { existsSync } from "node:fs";
import { copyFile, mkdir, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { controllerPorts } from "./ports";

async function startupOutput(stream: ReadableStream<Uint8Array>, started: number) {
  const lines: string[] = [];
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    const complete = `${pending}${decoder.decode(chunk, { stream: true })}`.split("\n");
    pending = complete.pop() ?? "";
    lines.push(...complete.map((line) => `[${Math.round(performance.now() - started)} ms] ${line}`));
  }
  pending += decoder.decode();
  if (pending) lines.push(`[${Math.round(performance.now() - started)} ms] ${pending}`);
  return lines.join("\n");
}

export async function nativeController(binary: string, directory: string, persistence = false) {
  const executable = join(directory, "pocketcoder");
  await copyFile(binary, executable);
  const tools = join(directory, "tools");
  await mkdir(tools);
  const docker = Bun.which("docker");
  if (!docker) throw new Error("Docker is required for controller reconciliation.");
  await symlink(docker, join(tools, "docker"));
  const reservation = controllerPorts();
  const port = reservation.operator;
  const agentPort = reservation.agent;
  reservation.release();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    PATH: tools,
    HOME: process.env.HOME,
    TMPDIR: directory,
    DOCKER_HOST: process.env.DOCKER_HOST,
    DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
    DOCKER_CONFIG: process.env.DOCKER_CONFIG,
    NO_COLOR: "1",
    POCKETCODER_HTTP: `127.0.0.1:${port}`,
    POCKETCODER_AGENT_HTTP: `0.0.0.0:${agentPort}`,
    POCKETCODER_WORKSPACE_SERVER_URL: `http://host.docker.internal:${agentPort}`,
    POCKETCODER_INPUT_DIR: join(directory, "inputs"),
    ...(persistence
      ? {
          POCKETCODER_STORAGE_BACKEND: "filesystem",
          POCKETCODER_WORKSPACE_DATA_DIR: join(directory, "live"),
          POCKETCODER_CHECKPOINT_DIR: join(directory, "checkpoints"),
        }
      : {}),
  };
  // A restored controller runs from its own data and checkpoint folders.
  let dataEnv: Record<string, string> = {};
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let output: Promise<string[]> | undefined;
  const measurements: { readinessMs: number; peakMemoryBytes?: number }[] = [];

  async function run(args: string[], key?: string) {
    const command = Bun.spawn([executable, ...args], {
      cwd: directory,
      env: { ...env, ...dataEnv, POCKETCODER_URL: baseUrl, POCKETCODER_KEY: key },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      command.exited,
      new Response(command.stdout).text(),
      new Response(command.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`${args.join(" ")} failed (${code}): ${stderr}`);
    return stdout;
  }

  async function stop() {
    if (!child) return;
    const processHandle = child;
    processHandle.kill("SIGTERM");
    const code = await processHandle.exited;
    const logs = (await output)?.join("\n") ?? "";
    child = undefined;
    const peakMemoryBytes = processHandle.resourceUsage()?.maxRSS;
    const measurement = measurements.at(-1);
    if (measurement) measurement.peakMemoryBytes = peakMemoryBytes;
    if (code !== 0) throw new Error(`Controller exited (${code}): ${logs}`);
    if (!peakMemoryBytes) throw new Error("Controller peak memory measurement is missing.");
    if (peakMemoryBytes > 512_000_000) throw new Error(`Controller exceeded 512 MB: ${peakMemoryBytes} bytes`);
    if (/DrizzleQueryError|protocol error: internal error/.test(logs)) throw new Error(logs);
  }

  // Recovery mode opens only the private admin socket, so it is ready when that socket exists.
  async function start(mode: "service" | "recovery" = "service") {
    const started = performance.now();
    const processHandle = Bun.spawn([executable, "serve"], {
      cwd: directory,
      env: { ...env, ...dataEnv },
      stdout: "pipe",
      stderr: "pipe",
    });
    child = processHandle;
    // Keep stage timing when a downloaded executable misses its startup budget.
    output = Promise.all([startupOutput(processHandle.stdout, started), startupOutput(processHandle.stderr, started)]);
    let ready = false;
    const socket = resolve(directory, dataEnv.POCKETCODER_DIR ?? "pc_data", "admin.sock");
    while (performance.now() - started < 10_000 && child.exitCode === null) {
      ready =
        mode === "recovery"
          ? existsSync(socket)
          : await fetch(`${baseUrl}/readyz`)
              .then((r) => r.ok)
              .catch(() => false);
      if (ready) break;
      await Bun.sleep(10);
    }
    const readinessMs = performance.now() - started;
    measurements.push({ readinessMs });
    if (!ready) {
      await stop();
      throw new Error(`Controller did not become ready: ${(await output)?.join("\n")}`);
    }
    if (readinessMs > 3000) {
      await stop();
      throw new Error(`Controller exceeded 3-second readiness: ${readinessMs} ms\n${(await output)?.join("\n")}`);
    }
  }

  function useDataFolder(dataDir: string, checkpointDir: string) {
    dataEnv = { POCKETCODER_DIR: dataDir, POCKETCODER_CHECKPOINT_DIR: checkpointDir };
  }

  return { executable, baseUrl, run, start, stop, useDataFolder, measurements };
}
