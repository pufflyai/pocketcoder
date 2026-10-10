import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseTemplateManifest } from "@pstdio/pocketcoder-contracts";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { buildLocalImage } from "../local/runtime";
import { bestEffort, command, freePort, waitFor } from "./local-process";

const root = resolve(import.meta.dir, "../..");
const directory = await mkdtemp(join(tmpdir(), "pc-preview-demo-"));
const dataDir = join(directory, "pc_data");
const operatorPort = freePort();
const agentPort = freePort();
const forwardPort = freePort();
const baseUrl = `http://127.0.0.1:${operatorPort}`;
const cli = ["bun", "--no-env-file", "packages/cli/src/index.ts"];
const imageTag = `pocketcoder-preview:${randomUUID()}`;
let controller: ReturnType<typeof Bun.spawn> | undefined;
let forward: ReturnType<typeof Bun.spawn> | undefined;
let client: PocketCoderClient | undefined;
let workspaceId: string | undefined;
const page = `<!doctype html><html><head><title>PocketCoder preview</title><link rel="stylesheet" href="/style.css"></head><body><h1>Docker workspace preview</h1><p id="reload">Connecting live reload…</p><script>const socket=new WebSocket(location.origin.replace('http','ws')+'/reload');socket.onopen=()=>socket.send('live reload works');socket.onmessage=(event)=>document.querySelector('#reload').textContent=event.data;</script></body></html>`;
const harness = `Bun.serve({hostname:'127.0.0.1',port:3284,fetch:()=>Response.json({status:'stable'})});Bun.serve({hostname:'127.0.0.1',port:3000,fetch(req,server){if(server.upgrade(req))return; if(new URL(req.url).pathname==='/style.css')return new Response('body{font-family:system-ui;padding:3rem;background:#f4f7fa;color:#182b40}',{headers:{'content-type':'text/css'}});if(req.headers.has('authorization')||req.headers.get('cookie')?.includes('pc-preview-session'))throw new Error('platform credential reached webapp');return new Response(${JSON.stringify(page)},{headers:{'content-type':'text/html'}})},websocket:{message(ws,data){ws.send(data)}}});`;

try {
  await command(
    ["bun", "build", "packages/supervisor/src/index.ts", "--target", "bun", "--outdir", "deploy/image/dist"],
    { quiet: true },
  );
  const image = await buildLocalImage({ root, imageTag, context: "deploy/image", command });
  const template = parseTemplateManifest({
    apiVersion: "pocketcoder.dev/v1alpha1",
    kind: "Template",
    metadata: { name: "preview-demo" },
    spec: {
      version: "1.0.0",
      image: image.image,
      harness: { command: ["bun", "-e", harness] },
      resources: { cpu: "1", memory: "256Mi" },
      services: { agent: { baseUrl: "http://127.0.0.1:3284", routes: [{ method: "GET", path: "/status" }] } },
      previews: { web: { port: 3000 } },
      timeouts: { terminateGrace: "2s" },
    },
  });
  const templates = join(directory, "templates");
  await mkdir(templates);
  await Bun.write(join(templates, "preview.json"), JSON.stringify(template.manifest));
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
          new Date(Date.now() + 60 * 60_000).toISOString(),
          "--request-id",
          randomUUID(),
          "--json",
        ],
        { quiet: true },
      )
    ).stdout,
  );
  const env = { POCKETCODER_URL: baseUrl, POCKETCODER_KEY: owner.token };
  await command([...cli, "templates", "import", templates], { env, quiet: true });
  client = new PocketCoderClient({ baseUrl, apiKey: owner.token });
  const workspace = await client.workspaces.create({ externalId: randomUUID(), templateName: "preview-demo" });
  workspaceId = workspace.id;
  await client.workspaces.waitForReady(workspace, 30_000);
  const minted = await client.previews.open(workspace.id, "web");
  const preview = new URL(minted.url);
  const request = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}${path}`, { redirect: "manual", headers: { host: preview.host, ...headers } });
  const exchange = await request(preview.pathname + preview.search);
  const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  if (exchange.status !== 303 || !cookie) throw new Error("Preview exchange failed");
  if ((await request(preview.pathname + preview.search)).status !== 401) throw new Error("Token was replayed");
  if (!(await (await request("/", { cookie })).text()).includes("Docker workspace preview"))
    throw new Error("HTML did not load");
  if (!(await (await request("/style.css", { cookie })).text()).includes("font-family"))
    throw new Error("CSS did not load");
  const socket = new WebSocket(baseUrl.replace("http", "ws") + "/reload", {
    headers: { host: preview.host, origin: preview.origin, cookie },
  } as unknown as string[]);
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("WebSocket failed"));
  });
  const reply = new Promise<string>((resolve) => {
    socket.onmessage = (event) => resolve(String(event.data));
  });
  socket.send("live reload works");
  if ((await reply) !== "live reload works") throw new Error("Live reload failed");
  socket.close();
  forward = Bun.spawn(
    [...cli, "workspaces", "forward", "--id", workspace.id, "--name", "web", "--port", String(forwardPort)],
    { cwd: root, env: { ...process.env, ...env }, stdout: "ignore", stderr: "inherit" },
  );
  await waitFor(
    () =>
      fetch(`http://127.0.0.1:${forwardPort}`)
        .then((response) => response.ok)
        .catch(() => false),
    5000,
    "loopback forwarding",
  );
  const forwarded = await fetch(`http://127.0.0.1:${forwardPort}/style.css`);
  if (!(await forwarded.text()).includes("font-family")) throw new Error("Forwarded CSS failed");
  if (process.argv.includes("--browser")) {
    console.log(`BROWSER_URL=${(await client.previews.open(workspace.id, "web")).url}`);
    console.log("Press Enter after checking the browser.");
    const reader = Bun.stdin.stream().getReader();
    await reader.read();
    reader.releaseLock();
  }
  await client.workspaces.cancel(workspace.id);
  if ((await request("/", { cookie })).ok) throw new Error("Ended preview remains accessible");
  workspaceId = undefined;
  console.log(
    JSON.stringify(
      {
        result: "passed",
        workspaceId: workspace.id,
        html: true,
        css: true,
        websocket: true,
        tokenReuse: "denied",
        loopbackForward: true,
        endedSession: "denied",
      },
      null,
      2,
    ),
  );
} finally {
  forward?.kill("SIGTERM");
  await forward?.exited;
  if (workspaceId) await client?.workspaces.cancel(workspaceId).catch(() => {});
  controller?.kill("SIGTERM");
  await controller?.exited;
  await bestEffort(["docker", "image", "rm", "--force", imageTag]);
  await rm(directory, { recursive: true, force: true });
}
