import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const docker = Bun.which("docker");
const available =
  docker !== null && Bun.spawnSync([docker, "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

async function waitFor(path: string) {
  const deadline = Date.now() + 10_000;
  while (!(await Bun.file(path).exists())) {
    if (Date.now() > deadline) throw new Error(`Fixture did not publish ${path}`);
    await Bun.sleep(10);
  }
  return JSON.parse(await readFile(path, "utf8"));
}

for (const mode of ["fresh", "existing"] as const)
  test.skipIf(!available)(
    `${mode} startup keeps real provider discovery and unknown-provider reconciliation before readiness`,
    async () => {
      if (!docker) throw new Error("Docker is required.");
      const directory = await mkdtemp(join(tmpdir(), "pc-discovery-"));
      const workspaceId = crypto.randomUUID();
      const name = `pc105-discovery-${workspaceId}`;
      let child: ReturnType<typeof Bun.spawn> | undefined;
      let output: Promise<string[]> | undefined;
      try {
        const provider = Bun.spawnSync(
          [
            docker,
            "create",
            "--name",
            name,
            "--network",
            "none",
            "--label",
            `pocketcoder.workspace=${workspaceId}`,
            "--label",
            "pocketcoder.template-digest=sha256:owned-fixture",
            "oven/bun:1.4.2",
            "bun",
            "--version",
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
        expect(provider.exitCode).toBe(0);
        const tools = join(directory, "tools");
        await mkdir(tools);
        const wrapper = join(tools, "docker");
        await Bun.write(
          wrapper,
          `#!${process.execPath}\nimport ${JSON.stringify(join(import.meta.dir, "startup-docker-fixture.ts"))};\n`,
        );
        await chmod(wrapper, 0o700);
        const processHandle = Bun.spawn([process.execPath, join(import.meta.dir, "startup-discovery-fixture.ts")], {
          env: {
            ...process.env,
            PATH: `${tools}:${process.env.PATH}`,
            PC_DISCOVERY_FIXTURE: directory,
            PC_DISCOVERY_DOCKER: docker,
            PC_DISCOVERY_MODE: mode,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        child = processHandle;
        output = Promise.all([new Response(processHandle.stdout).text(), new Response(processHandle.stderr).text()]);
        const discovery = await waitFor(join(directory, "discovery.json"));
        expect(discovery.keysExist).toBe(true);
        expect(await Bun.file(join(directory, "result.json")).exists()).toBe(false);
        expect(await Bun.file(join(directory, "spawn.json")).exists()).toBe(mode === "fresh");
        const spawn = mode === "fresh" ? await waitFor(join(directory, "spawn.json")) : undefined;
        if (spawn) {
          expect(spawn.keysExist).toBe(true);
          // Wrapper module loading may finish after extraction; the actual spawn precedes it.
          expect(spawn.databaseExists).toBe(false);
        } else expect(discovery.databaseExists).toBe(true);
        const lease = await waitFor(join(directory, "lease.json"));
        if (spawn) expect(lease.epochMs).toBeGreaterThanOrEqual(spawn.epochMs);
        expect(await Bun.file(join(directory, "result.json")).exists()).toBe(false);
        await Bun.write(join(directory, "release"), "release");
        const code = await child.exited;
        const logs = await output;
        expect(code, logs.join("\n")).toBe(0);
        const result = await waitFor(join(directory, "result.json"));
        expect(result.status).toBe(200);
        const quarantine = result.messages.findIndex((message: string) =>
          message.includes(`unknown provider object for workspace ${workspaceId}`),
        );
        const listening = result.messages.findIndex((message: string) => message.includes("listening on"));
        expect(quarantine).toBeGreaterThanOrEqual(0);
        expect(quarantine).toBeLessThan(listening);
        console.info(
          JSON.stringify({
            proof: "startup-discovery-overlap",
            mode,
            provider: new TextDecoder().decode(provider.stdout).trim(),
            workspaceId,
            discovery,
            spawn,
            lease,
            status: result.status,
            quarantineBeforeListen: quarantine < listening,
            fixtureExit: code,
          }),
        );
      } finally {
        await Bun.write(join(directory, "release"), "release");
        if (child) {
          const deadline = Date.now() + 10_000;
          while (child.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
          if (child.exitCode === null) child.kill("SIGTERM");
          await child.exited;
          await output;
        }
        const cleanup = Bun.spawnSync([docker, "rm", "--force", name], { stdout: "pipe", stderr: "pipe" });
        expect(cleanup.exitCode).toBe(0);
        console.info(JSON.stringify({ proof: "startup-discovery-cleanup", provider: name, exit: cleanup.exitCode }));
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );
