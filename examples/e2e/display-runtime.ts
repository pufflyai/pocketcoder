import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { KeyIssueResponseSchema, type TemplateManifest } from "@pstdio/pocketcoder-contracts";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { buildLocalImage } from "../local/runtime";
import { command, freePort, waitFor } from "./local-process";

export async function startDisplayDemo(
  mode: "desktop" | "browser",
  prepare?: (template: TemplateManifest) => void,
  environment: Record<string, string> = {},
) {
  const root = resolve(import.meta.dir, "../..");
  const directory = await mkdtemp(join(tmpdir(), `pc-${mode}-demo-`));
  const dataDir = join(directory, "pc_data");
  const operatorPort = freePort(),
    agentPort = freePort();
  const baseUrl = `http://127.0.0.1:${operatorPort}`;
  const cli = ["bun", "--no-env-file", "packages/cli/src/index.ts"];
  let controller: ReturnType<typeof Bun.spawn> | undefined;
  let client: PocketCoderClient | undefined;
  let workspaceId: string | undefined;
  async function close() {
    if (client && workspaceId) await client.workspaces.cancel(workspaceId).catch(() => {});
    controller?.kill("SIGTERM");
    await controller?.exited;
    await rm(directory, { recursive: true, force: true });
  }
  try {
    await command(
      ["bun", "build", "packages/supervisor/src/index.ts", "--target", "bun", "--outdir", "deploy/image/dist"],
      { quiet: true },
    );
    await buildLocalImage({ root, imageTag: "pocketcoder-workspace:dev", context: "deploy/image", command });
    const image = await buildLocalImage({
      root,
      imageTag: `pocketcoder-${mode}:dev`,
      context: "deploy/image",
      dockerfile: `deploy/image/${mode}.Dockerfile`,
      command,
    });
    const size = Number(
      (
        await command(["docker", "image", "inspect", `pocketcoder-${mode}:dev`, "--format", "{{.Size}}"], {
          quiet: true,
        })
      ).stdout,
    );
    if (mode === "desktop" && size >= 1_500_000_000) throw new Error("Desktop image exceeds 1.5 GB.");
    const template = (await Bun.file(join(root, `examples/templates/${mode}.json`)).json()) as TemplateManifest;
    template.spec.image = image.image;
    prepare?.(template);
    const templates = join(directory, "templates");
    await mkdir(templates);
    await Bun.write(join(templates, `${mode}.json`), JSON.stringify(template));
    controller = Bun.spawn([...cli, "serve", "--dir", dataDir], {
      cwd: root,
      env: {
        ...process.env,
        POCKETCODER_HTTP: `127.0.0.1:${operatorPort}`,
        POCKETCODER_AGENT_HTTP: `0.0.0.0:${agentPort}`,
        POCKETCODER_WORKSPACE_SERVER_URL: `http://host.docker.internal:${agentPort}`,
        POCKETCODER_STORAGE_BACKEND: "disabled",
        POCKETCODER_SECRET_PROVIDER: "disabled",
        POCKETCODER_WARM_POOLS: "[]",
        POCKETCODER_INPUT_DIR: join(directory, "inputs"),
        ...environment,
      },
      stdout: "ignore",
      stderr: "inherit",
    });
    await waitFor(
      () =>
        fetch(`${baseUrl}/readyz`)
          .then((response) => response.ok)
          .catch(() => false),
      15_000,
      "controller ready",
    );
    const owner = KeyIssueResponseSchema.parse(
      JSON.parse(
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
              new Date(Date.now() + 3_600_000).toISOString(),
              "--request-id",
              randomUUID(),
              "--json",
            ],
            { quiet: true },
          )
        ).stdout,
      ),
    );
    if (!owner.token) throw new Error("Owner token was not issued.");
    await command([...cli, "templates", "import", templates], {
      env: { POCKETCODER_URL: baseUrl, POCKETCODER_KEY: owner.token },
      quiet: true,
    });
    const authorized = new PocketCoderClient({ baseUrl, apiKey: owner.token });
    client = authorized;
    const workspace = await authorized.workspaces.create({ externalId: randomUUID(), templateName: mode });
    workspaceId = workspace.id;
    await authorized.workspaces.waitForReady(workspace, 30_000);
    async function open(control: boolean, caller = authorized) {
      const url = new URL((await caller.displays.open(workspace.id, control)).url);
      const response = await fetch(`${baseUrl}${url.pathname}${url.search}`, {
        redirect: "manual",
        headers: { host: url.host },
      });
      if (response.status !== 303) throw new Error("Display exchange failed.");
      const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
      return { url, cookie };
    }
    return { client: authorized, owner: owner.key, workspace, baseUrl, open, close, size };
  } catch (error) {
    await close();
    throw error;
  }
}
