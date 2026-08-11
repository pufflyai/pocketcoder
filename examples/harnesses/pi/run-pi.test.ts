import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

test("reads a projected secret path before writing Pi's model config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pocketcoder-pi-"));
  temporaryDirectories.push(directory);
  const agentDirectory = join(directory, "agent");
  const bearerPath = join(directory, "bearer");
  await Bun.write(bearerPath, "ephemeral-session-token\n");

  const process = Bun.spawn(["/bin/sh", "./run-pi"], {
    cwd: import.meta.dir,
    env: {
      ...Bun.env,
      PI_CODING_AGENT_DIR: agentDirectory,
      PI_EXECUTABLE: "/usr/bin/true",
      PI_GATEWAY_BEARER: bearerPath,
      PI_GATEWAY_MODEL: "gpt-test",
      PI_GATEWAY_URL: "http://gateway.test/v1",
    },
    stderr: "pipe",
  });

  expect(await process.exited).toBe(0);
  const config = await Bun.file(join(agentDirectory, "models.json")).json();
  expect(config.providers["pocketcoder-gateway"].apiKey).toBe("ephemeral-session-token");
});
