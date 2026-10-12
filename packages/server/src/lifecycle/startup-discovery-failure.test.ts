import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { openControllerStore } from "../bootstrap/controller-store";

const docker = Bun.which("docker");
const available =
  docker !== null && Bun.spawnSync([docker, "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

async function fixture(mode: string) {
  if (!docker) throw new Error("Docker is required.");
  const directory = await mkdtemp(join(tmpdir(), "pc-discovery-failure-"));
  const tools = join(directory, "tools");
  await mkdir(tools);
  const wrapper = join(tools, "docker");
  const storage = mode === "init-failure" ? await objectStorageFixture() : undefined;
  try {
    if (storage) await writeFile(join(directory, "storage.json"), JSON.stringify(storage.config), { mode: 0o600 });
    await Bun.write(
      wrapper,
      `#!${process.execPath}\nimport ${JSON.stringify(join(import.meta.dir, "startup-docker-fixture.ts"))};\n`,
    );
    await chmod(wrapper, 0o700);
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "startup-discovery-fixture.ts")], {
      env: {
        ...process.env,
        PATH: `${tools}:${process.env.PATH}`,
        PC_DISCOVERY_MODE: mode,
        PC_DISCOVERY_FIXTURE: directory,
        PC_DISCOVERY_DOCKER: docker,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return {
      directory,
      child,
      output,
      async dispose() {
        try {
          await Bun.write(join(directory, "release"), "release");
          const deadline = Date.now() + 5000;
          while (child.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
          if (child.exitCode === null) child.kill("SIGTERM");
          await child.exited;
          await output;
          if (await Bun.file(join(directory, "discovery.json")).exists()) {
            const settled = join(directory, "discovery-settled.json");
            const deadline = Date.now() + 5000;
            while (!(await Bun.file(settled).exists())) {
              if (Date.now() > deadline) throw new Error("Owned Docker wrapper did not settle.");
              await Bun.sleep(10);
            }
            console.info(
              JSON.stringify({ proof: "startup-discovery-query-cleanup", ...(await Bun.file(settled).json()) }),
            );
          }
          await rm(directory, { recursive: true, force: true });
        } finally {
          await storage?.close();
        }
      },
    };
  } catch (error) {
    await storage?.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

test.skipIf(!available)(
  "invalid private keys reject before any real provider query starts",
  async () => {
    const f = await fixture("invalid-keys");
    try {
      expect(await f.child.exited).toBe(1);
      const logs = (await f.output).join("\n");
      expect(logs).toContain("controller key must be a private 32-byte file");
      expect(await Bun.file(join(f.directory, "spawn.json")).exists()).toBe(false);
      expect(await Bun.file(join(f.directory, "discovery.json")).exists()).toBe(false);
      expect(await Bun.file(join(f.directory, "data", "db", "PG_VERSION")).exists()).toBe(false);
    } finally {
      await f.dispose();
    }
  },
  10_000,
);

test.skipIf(!available)(
  "a held controller folder rejects before provider discovery",
  async () => {
    const f = await fixture("busy");
    try {
      expect(await f.child.exited).toBe(1);
      expect((await f.output).join("\n")).toContain("data folder is in use");
      expect(await Bun.file(join(f.directory, "spawn.json")).exists()).toBe(false);
      expect(await Bun.file(join(f.directory, "discovery.json")).exists()).toBe(false);
    } finally {
      await f.dispose();
    }
  },
  10_000,
);

test.skipIf(!available)(
  "initialization failure drains the owned read-only query and preserves its original error",
  async () => {
    const f = await fixture("init-failure");
    try {
      const deadline = Date.now() + 5000;
      while (!(await Bun.file(join(f.directory, "discovery.json")).exists()) && f.child.exitCode === null) {
        if (Date.now() > deadline) throw new Error("Real provider query did not start.");
        await Bun.sleep(10);
      }
      expect(await Bun.file(join(f.directory, "discovery.json")).exists()).toBe(true);
      let opened: Awaited<ReturnType<typeof openControllerStore>> | undefined;
      while (!opened && Date.now() < deadline) {
        try {
          opened = await openControllerStore(join(f.directory, "data"));
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("data folder is in use")) throw error;
          await Bun.sleep(10);
        }
      }
      expect(opened).toBeDefined();
      await opened?.store.close();
      // Initialization released its writer, but startup cannot reject with a query still owned.
      expect(f.child.exitCode).toBeNull();
      expect(await Bun.file(join(f.directory, "result.json")).exists()).toBe(false);
      await Bun.write(join(f.directory, "release"), "release");
      expect(await f.child.exited).toBe(1);
      const logs = (await f.output).join("\n");
      expect(logs).toContain("Off-node encryption key must differ from the controller key bundle.");
      expect(logs).not.toContain("Unhandled");
      console.info(
        JSON.stringify({
          proof: "startup-discovery-init-failure",
          exit: f.child.exitCode,
          writerReleased: true,
          originalError: true,
          querySettledBeforeExit: true,
        }),
      );
    } finally {
      await f.dispose();
    }
  },
  15_000,
);

for (const mode of ["checkpoint-failure", "checkpoint-log-failure"] as const)
  test.skipIf(!available)(
    `${mode} drains discovery before startup rejects`,
    async () => {
      const f = await fixture(mode);
      try {
        const deadline = Date.now() + 5000;
        const failure = join(f.directory, "error.json");
        while (!(await Bun.file(failure).exists()) && f.child.exitCode === null) {
          if (Date.now() > deadline) throw new Error("Checkpoint failure did not reach startup cleanup.");
          await Bun.sleep(10);
        }
        if (f.child.exitCode !== null) {
          expect((await f.output).join("\n")).toContain("EEXIST");
          console.info(
            JSON.stringify({
              proof: "startup-discovery-checkpoint-red",
              originalError: "EEXIST",
              prematureExit: f.child.exitCode,
            }),
          );
        }
        expect(await Bun.file(failure).exists()).toBe(true);
        expect(await Bun.file(join(f.directory, "spawn.json")).exists()).toBe(true);
        expect(f.child.exitCode).toBeNull();
        expect(await Bun.file(join(f.directory, "result.json")).exists()).toBe(false);
        await Bun.write(join(f.directory, "release"), "release");
        expect(await f.child.exited).toBe(1);
        expect((await f.output).join("\n")).toContain("EEXIST");
        expect((await f.output).join("\n")).not.toContain("owned log sink failed");
        const reopened = await openControllerStore(join(f.directory, "data"));
        await reopened.store.close();
        console.info(
          JSON.stringify({
            proof: "startup-discovery-checkpoint-failure",
            mode,
            originalError: "EEXIST",
            drained: true,
            writerReopened: true,
            exit: f.child.exitCode,
          }),
        );
      } finally {
        await f.dispose();
      }
    },
    15_000,
  );
