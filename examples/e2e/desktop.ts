import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { buildLocalImage } from "../local/runtime";
import { connectDesktop } from "./desktop-client";
import { command, freePort, waitFor } from "./local-process";

const root = resolve(import.meta.dir, "../..");
const directory = await mkdtemp(join(tmpdir(), "pc-desktop-demo-"));
const dataDir = join(directory, "pc_data");
const operatorPort = freePort(),
  agentPort = freePort();
const baseUrl = `http://127.0.0.1:${operatorPort}`;
const cli = ["bun", "--no-env-file", "packages/cli/src/index.ts"];
let controller: ReturnType<typeof Bun.spawn> | undefined;
let client: PocketCoderClient | undefined;
let workspaceId: string | undefined;
const sockets: WebSocket[] = [];

try {
  await command(
    ["bun", "build", "packages/supervisor/src/index.ts", "--target", "bun", "--outdir", "deploy/image/dist"],
    { quiet: true },
  );
  await buildLocalImage({ root, imageTag: "pocketcoder-workspace:dev", context: "deploy/image", command });
  const image = await buildLocalImage({
    root,
    imageTag: "pocketcoder-desktop:dev",
    context: "deploy/image",
    dockerfile: "deploy/image/desktop.Dockerfile",
    command,
  });
  const size = Number(
    (await command(["docker", "image", "inspect", "pocketcoder-desktop:dev", "--format", "{{.Size}}"], { quiet: true }))
      .stdout,
  );
  if (size >= 1_500_000_000) throw new Error("Desktop image exceeds 1.5 GB.");
  const template = await Bun.file(join(root, "examples/templates/desktop.json")).json();
  template.spec.image = image.image;
  const templates = join(directory, "templates");
  await mkdir(templates);
  await Bun.write(join(templates, "desktop.json"), JSON.stringify(template));
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
          new Date(Date.now() + 3_600_000).toISOString(),
          "--request-id",
          randomUUID(),
          "--json",
        ],
        { quiet: true },
      )
    ).stdout,
  );
  await command([...cli, "templates", "import", templates], {
    env: { POCKETCODER_URL: baseUrl, POCKETCODER_KEY: owner.token },
    quiet: true,
  });
  client = new PocketCoderClient({ baseUrl, apiKey: owner.token });
  const workspace = await client.workspaces.create({ externalId: randomUUID(), templateName: "desktop" });
  workspaceId = workspace.id;
  await client.workspaces.waitForReady(workspace, 30_000);
  const open = async (control: boolean) => {
    if (!client) throw new Error("Missing client");
    const url = new URL((await client.displays.open(workspace.id, control)).url);
    const response = await fetch(`${baseUrl}${url.pathname}${url.search}`, {
      redirect: "manual",
      headers: { host: url.host },
    });
    if (response.status !== 303) throw new Error("Display exchange failed.");
    const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    return { url, cookie };
  };
  const viewing = await open(false);
  const viewer = await connectDesktop(baseUrl, viewing.url, viewing.cookie);
  sockets.push(viewer.socket);
  const screen = await viewer.capture();
  viewer.socket.send(new Uint8Array([4, 1, 0]));
  viewer.socket.send(new Uint8Array([0, 0, 0, 0, 65]));
  await Promise.race([
    viewer.closed,
    Bun.sleep(2000).then(() => {
      throw new Error("Forged view-only input was not closed.");
    }),
  ]);
  const controlled = await open(true);
  const control = await connectDesktop(baseUrl, controlled.url, controlled.cookie);
  sockets.push(control.socket);
  await control.capture();
  const second = await open(true);
  await connectDesktop(baseUrl, second.url, second.cookie).then(
    () => {
      throw new Error("Second controller was allowed.");
    },
    () => {},
  );
  control.click(300, 250);
  control.type("printf pc-control > /tmp/desktop-control-proof");
  const containers = (
    await command(["docker", "ps", "-q", "--filter", `name=pocketcoder-ws-${workspace.id}`], { quiet: true })
  ).stdout;
  if (!containers) throw new Error("Missing desktop container.");
  await waitFor(
    () =>
      command(["docker", "exec", containers.split("\n")[0] ?? "", "cat", "/tmp/desktop-control-proof"], { quiet: true })
        .then((result) => result.stdout === "pc-control")
        .catch(() => false),
    5000,
    "authorized desktop input",
  );
  const changed = await control.capture();
  if (changed === screen) throw new Error("Authorized input did not change the desktop.");
  if (process.argv.includes("--browser")) {
    control.socket.close();
    await control.closed;
    console.log(`BROWSER_URL=${(await client.displays.open(workspace.id, true)).url}`);
    console.log("Press Enter after checking the browser.");
    const reader = Bun.stdin.stream().getReader();
    await reader.read();
    reader.releaseLock();
  }
  await client.workspaces.cancel(workspace.id);
  await Promise.race([
    control.closed,
    Bun.sleep(2000).then(() => {
      throw new Error("Ended display did not close.");
    }),
  ]);
  console.log(
    JSON.stringify({
      result: "passed",
      imageBytes: size,
      nonblank: true,
      typedInput: true,
      forgedInput: "denied",
      secondController: "denied",
      endedSession: "closed",
    }),
  );
} finally {
  for (const socket of sockets) socket.close();
  if (client && workspaceId) await client.workspaces.cancel(workspaceId).catch(() => {});
  controller?.kill("SIGTERM");
  await controller?.exited;
  await rm(directory, { recursive: true, force: true });
}
