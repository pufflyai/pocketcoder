import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { command, waitFor } from "./local-process";

export async function startDockerImageController(options: {
  image: string;
  directory: string;
  operatorPort: number;
  agentPort: number;
  environment?: Record<string, string>;
  serviceCommand?: string[];
}) {
  const name = `pc-candidate-controller-${randomUUID()}`;
  const dataDir = join(options.directory, "pc_data");
  await mkdir(join(options.directory, "inputs"), { recursive: true });
  const environment = {
    POCKETCODER_DIR: dataDir,
    POCKETCODER_HTTP: "0.0.0.0:8090",
    POCKETCODER_AGENT_HTTP: "0.0.0.0:8091",
    POCKETCODER_INPUT_DIR: join(options.directory, "inputs"),
    POCKETCODER_WORKSPACE_SERVER_URL: `http://host.docker.internal:${options.agentPort}`,
    POCKETCODER_STORAGE_BACKEND: "disabled",
    POCKETCODER_SECRET_PROVIDER: "disabled",
    POCKETCODER_WARM_POOLS: "[]",
    ...options.environment,
  };
  await command(["docker", "volume", "create", name], { quiet: true });
  await command(
    [
      "docker",
      "run",
      "-d",
      "--name",
      name,
      "-p",
      `127.0.0.1:${options.operatorPort}:8090`,
      "-p",
      `0.0.0.0:${options.agentPort}:8091`,
      "--mount",
      `type=bind,src=${options.directory},dst=${options.directory}`,
      "--mount",
      `type=volume,src=${name},dst=${dataDir}`,
      "--mount",
      "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock",
      ...Object.entries(environment).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      options.image,
      ...(options.serviceCommand ?? ["pocketcoder", "serve", "--dir", dataDir]),
    ],
    { quiet: true },
  );
  const baseUrl = `http://127.0.0.1:${options.operatorPort}`;
  const cli = ["docker", "exec", name, "pocketcoder"];
  const measurement = { readinessMs: 0, peakMemoryBytes: 0 };
  const readPeakMemory = async () =>
    Number(
      (
        await command(
          ["docker", "exec", name, "bun", "-e", "console.log(await Bun.file('/sys/fs/cgroup/memory.peak').text())"],
          { quiet: true },
        )
      ).stdout,
    );
  const close = async () => {
    try {
      measurement.peakMemoryBytes = await readPeakMemory();
      if (!measurement.peakMemoryBytes || measurement.peakMemoryBytes > 512_000_000)
        throw new Error(`Image controller exceeded 512 MB: ${measurement.peakMemoryBytes} bytes`);
      await command(["docker", "stop", "--time", "3", name], { quiet: true });
      const exitCode = (
        await command(["docker", "inspect", name, "--format", "{{.State.ExitCode}}"], { quiet: true })
      ).stdout.trim();
      if (exitCode !== "0") throw new Error(`Public image CLI exited ${exitCode} after SIGTERM`);
    } finally {
      await command(["docker", "rm", "--force", name], { quiet: true });
      await command(["docker", "volume", "rm", name], { quiet: true });
    }
  };
  try {
    await waitFor(
      () =>
        fetch(`${baseUrl}/readyz`).then(
          (r) => r.ok,
          () => false,
        ),
      30_000,
      "candidate Docker controller",
    );
    const startedAt = (await command(["docker", "inspect", name, "--format", "{{.State.StartedAt}}"], { quiet: true }))
      .stdout;
    const readinessMs = Date.now() - Date.parse(startedAt);
    if (readinessMs > 3000) throw new Error(`Image controller exceeded 3-second readiness: ${readinessMs} ms`);
    measurement.readinessMs = readinessMs;
    measurement.peakMemoryBytes = await readPeakMemory();
    if (!measurement.peakMemoryBytes || measurement.peakMemoryBytes > 512_000_000)
      throw new Error(`Image controller exceeded 512 MB: ${measurement.peakMemoryBytes} bytes`);
    return { name, cli, close, baseUrl, dataDir, measurement };
  } catch (error) {
    console.log(await command(["docker", "logs", name], { quiet: true }));
    await close();
    throw error;
  }
}
