import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseTemplateManifest } from "@pstdio/pocketcoder-contracts";
import { buildLocalImage } from "../local/runtime";
import { createCheckpointInterruptionProxy } from "./checkpoint-interruption-proxy";
import { createHarnessWorkspace } from "./contract";
import { bestEffort, command, freePort, waitFor } from "./local-process";

export async function checkpointSourceFixture(options: { deadlinePolicy?: boolean } = {}) {
  const root = resolve(import.meta.dir, "../..");
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pc-source-survival-")));
  const dataDir = join(directory, "pc_data");
  const checkpointDir = join(directory, "checkpoints");
  const imageTag = `pocketcoder-source-survival:${randomUUID()}`;
  const operatorPort = freePort();
  const agentPort = freePort();
  const proxyPort = freePort();
  const baseUrl = `http://127.0.0.1:${operatorPort}`;
  const cli = ["bun", "--no-env-file", "packages/cli/src/index.ts"];
  await command(
    ["bun", "build", "packages/supervisor/src/index.ts", "--target", "bun", "--outdir", "deploy/image/dist"],
    { quiet: true },
  );
  const image = await buildLocalImage({ root, imageTag, context: "deploy/image", command });
  const manifest = JSON.parse(await readFile(join(root, "examples/harnesses/echo/template.json"), "utf8"));
  manifest.spec.image = image.image;
  manifest.spec.persistence = { mounts: [{ name: "work", target: "/work", maxBytes: 1024 * 1024, maxFiles: 100 }] };
  if (options.deadlinePolicy) {
    manifest.spec.persistence.checkpoint = { onDeadline: "preserve" };
    manifest.spec.timeouts = { ...manifest.spec.timeouts, maxAge: "30s" };
  }
  const parsed = parseTemplateManifest(manifest);
  const templateDir = join(directory, "templates");
  await mkdir(templateDir);
  const templatePath = join(templateDir, "echo.json");
  await writeFile(templatePath, JSON.stringify(parsed.manifest));
  const proxy = createCheckpointInterruptionProxy(proxyPort, agentPort);
  const controller = Bun.spawn([...cli, "serve", "--dir", dataDir], {
    cwd: root,
    env: {
      ...process.env,
      POCKETCODER_DIR: dataDir,
      POCKETCODER_TEMPLATE_DIR: undefined,
      POCKETCODER_HTTP: `127.0.0.1:${operatorPort}`,
      POCKETCODER_AGENT_HTTP: `0.0.0.0:${agentPort}`,
      POCKETCODER_WORKSPACE_SERVER_URL: `http://host.docker.internal:${proxyPort}`,
      POCKETCODER_INPUT_DIR: join(directory, "inputs"),
      POCKETCODER_STORAGE_BACKEND: "filesystem",
      POCKETCODER_WORKSPACE_DATA_DIR: join(directory, "live"),
      POCKETCODER_CHECKPOINT_DIR: checkpointDir,
      POCKETCODER_MAX_CHECKPOINT_FILES: options.deadlinePolicy ? "100" : "1",
      POCKETCODER_SECRET_PROVIDER: "disabled",
      POCKETCODER_WARM_POOLS: "[]",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = Promise.all([new Response(controller.stdout).text(), new Response(controller.stderr).text()]);
  const sources: string[] = [];
  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    controller.kill("SIGTERM");
    await controller.exited;
    console.log((await output).join("\n"));
    await proxy.close();
  }
  try {
    await waitFor(
      async () => {
        if (controller.exitCode !== null) throw new Error(`Controller exited: ${(await output).join("\n")}`);
        return fetch(`${baseUrl}/readyz`)
          .then((response) => response.ok)
          .catch(() => false);
      },
      30_000,
      "source survival controller",
    );
    const owner = JSON.parse(
      (
        await command(
          [
            ...cli,
            "superuser",
            "create",
            "--dir",
            dataDir,
            "--automation",
            "--expires",
            new Date(Date.now() + 600_000).toISOString(),
            "--request-id",
            randomUUID(),
            "--json",
          ],
          { quiet: true },
        )
      ).stdout,
    );
    const env = { POCKETCODER_URL: baseUrl, POCKETCODER_KEY: owner.token };
    await command([...cli, "templates", "import", templateDir], { env, quiet: true });
    return {
      dataDir,
      checkpointDir,
      proxy,
      stop,
      ownWorkspace: (id: string) => sources.push(id),
      async createSource() {
        const source = await createHarnessWorkspace({ baseUrl, key: owner.token, template: "echo-harness" });
        sources.push(source.workspaceId);
        return source;
      },
      async dispose() {
        await stop();
        for (const id of sources) {
          const name = `pocketcoder-ws-${id}`;
          const listed = await command(["docker", "ps", "-aq", "--filter", `name=^/${name}$`], { quiet: true });
          if (listed.stdout) {
            console.log(`Source ${id} final container state:`);
            await command(["docker", "inspect", "--format", "{{json .State}}", name]);
            const logs = await command(["docker", "logs", name], { quiet: true });
            console.log(logs.stdout, logs.stderr);
          }
          await bestEffort(["docker", "rm", "--force", name]);
        }
        await bestEffort(["docker", "image", "rm", "--force", imageTag]);
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await stop();
    await bestEffort(["docker", "image", "rm", "--force", imageTag]);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
