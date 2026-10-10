import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTemplateManifest } from "@pstdio/pocketcoder-contracts";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { supervise } from "@pstdio/pocketcoder-supervisor";
import { waitFor } from "../testing/e2e-test-support";
import { createTestServer } from "../testing/test-server.test";

const createStore = createTestStoreFactory();

test("real supervisor relays assets and live reload, strips authority, and closes a revoked browser socket", async () => {
  const captured: Headers[] = [];
  let uploadRequests = 0;
  const webapp = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      captured.push(request.headers);
      if (server.upgrade(request)) return;
      const path = new URL(request.url).pathname;
      if (path === "/delayed-upload") uploadRequests++;
      if (path === "/waiting-headers") return new Promise<Response>(() => {});
      if (path === "/style.css") return new Response("body{color:red}", { headers: { "content-type": "text/css" } });
      if (path === "/redirect") return new Response(null, { status: 302, headers: { location: "/style.css" } });
      if (path === "/slow")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(65536));
            },
            cancel() {},
          }),
        );
      return new Response('<link rel="stylesheet" href="/style.css"><h1>Preview</h1>', {
        headers: { "content-type": "text/html" },
      });
    },
    websocket: {
      message(socket, message) {
        socket.send(message);
      },
    },
  });
  const health = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ status: "stable" }) });
  const directory = await mkdtemp(join(tmpdir(), "pc-preview-"));
  const server = await createTestServer(await createStore());
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, socketServer) =>
      new URL(request.url).pathname.startsWith("/v1/agent/")
        ? server.agentApp.fetch(request, socketServer)
        : server.app.fetch(request, socketServer),
    websocket: server.websocket,
  });
  const baseUrl = `http://127.0.0.1:${listener.port}`;
  const client = new PocketCoderClient({ baseUrl, apiKey: server.token });
  const found = await server.store.getMachineKeyWithPrincipal(server.keyId);
  if (!found) throw new Error("missing key");
  await server.store.updatePrincipal(
    found.principal.id,
    [...found.principal.scopes, "previews:open"],
    found.principal.templateNames,
  );
  const parsed = parseTemplateManifest({
    apiVersion: "pocketcoder.dev/v1alpha1",
    kind: "Template",
    metadata: { name: "fixture-echo" },
    spec: {
      version: "2.0.0",
      image: `test@sha256:${"d".repeat(64)}`,
      resources: { cpu: "1", memory: "128Mi" },
      harness: { command: [process.execPath, "-e", "setInterval(()=>{},1000)"] },
      services: { agent: { baseUrl: `http://127.0.0.1:${health.port}`, routes: [{ method: "GET", path: "/status" }] } },
      previews: { web: { port: webapp.port } },
      timeouts: { terminateGrace: "1s" },
    },
  });
  await server.store.upsertTemplate({
    name: parsed.manifest.metadata.name,
    version: parsed.manifest.spec.version,
    digest: parsed.digest,
    description: null,
    spec: parsed.manifest.spec,
  });
  const workspace = await client.workspaces.create({ externalId: randomUUID(), templateName: "fixture-echo" });
  await server.scheduler.tick();
  const input = server.driver.inputFor(workspace.id);
  const path = join(directory, "input.json");
  await Bun.write(path, JSON.stringify({ ...input, server_url: baseUrl }));
  const done = supervise(path);
  let socket: WebSocket | undefined;
  const headerAbort = new AbortController();
  try {
    await waitFor(
      async () => (await server.store.getWorkspace(workspace.id))?.state === "ready",
      5000,
      "preview workspace ready",
    );
    expect(await client.previews.list(workspace.id)).toEqual([{ name: "web", port: Number(webapp.port) }]);
    const minted = await client.previews.open(workspace.id, "web");
    const preview = new URL(minted.url);
    const request = (path: string, init: RequestInit = {}) =>
      fetch(`${baseUrl}${path}`, { ...init, redirect: "manual", headers: { host: preview.host, ...init.headers } });
    const exchange = await request(preview.pathname + preview.search);
    expect(exchange.status).toBe(303);
    const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const page = await request("/", {
      headers: { cookie, authorization: `Bearer ${server.token}`, "x-pocketcoder-registration": "standing-secret" },
    });
    expect(await page.text()).toContain("<h1>Preview</h1>");
    expect(await (await request("/style.css", { headers: { cookie } })).text()).toBe("body{color:red}");
    expect((await request("/redirect", { headers: { cookie } })).headers.get("location")).toBe("/style.css");
    expect(
      (await request("/", { method: "POST", headers: { cookie, origin: "http://foreign.localhost" }, body: "bad" }))
        .status,
    ).toBe(401);
    expect(
      (await request("/", { method: "POST", headers: { cookie, origin: preview.origin }, body: "ok" })).status,
    ).toBe(200);
    const slow = await request("/slow", { headers: { cookie } });
    await waitFor(async () => server.hub.activeStreamCount(workspace.id) === 1, 1000, "slow stream");
    expect((await client.workspaces.get(workspace.id)).state).toBe("ready");
    const liveUrl = new URL(`${baseUrl}/reload`);
    liveUrl.protocol = "ws:";
    const liveSocket = new WebSocket(liveUrl, {
      headers: { host: preview.host, cookie: `${cookie}; app-session=allowed`, origin: preview.origin },
    } as unknown as string[]);
    socket = liveSocket;
    await new Promise<void>((resolve, reject) => {
      liveSocket.onopen = () => resolve();
      liveSocket.onerror = () => reject(new Error("preview socket failed"));
    });
    const reply = new Promise<string>((resolve) => {
      liveSocket.onmessage = (event) => resolve(String(event.data));
    });
    socket.send("reload");
    expect(await reply).toBe("reload");
    expect(
      captured.every(
        (headers) =>
          !headers.has("authorization") &&
          !headers.get("cookie")?.includes("pc-preview-session") &&
          !headers.has("x-pocketcoder-registration"),
      ),
    ).toBe(true);
    expect(captured.some((headers) => headers.get("cookie") === "app-session=allowed")).toBe(true);
    const closed = new Promise<void>((resolve) => {
      liveSocket.onclose = () => resolve();
    });
    let uploadController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const uploading = request("/delayed-upload", {
      method: "POST",
      headers: { cookie, origin: preview.origin },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          uploadController = controller;
          controller.enqueue(new Uint8Array([1]));
        },
      }),
    });
    await Bun.sleep(400);
    const waiting = request("/waiting-headers", { headers: { cookie }, signal: headerAbort.signal });
    await waitFor(async () => server.hub.activeStreamCount(workspace.id) === 2, 1000, "waiting for upstream headers");
    await server.store.revokeMachineKey(server.keyId, new Date());
    await closed;
    try {
      uploadController?.close();
    } catch {}
    expect((await uploading).status).toBe(401);
    expect(uploadRequests).toBe(0);
    await waitFor(async () => server.hub.activeStreamCount(workspace.id) === 0, 1000, "revoked HTTP requests close");
    expect((await waiting).status).toBe(401);
    expect((await request("/", { headers: { cookie } })).status).toBe(401);
    await slow.body?.cancel().catch(() => {});
  } finally {
    headerAbort.abort();
    socket?.close();
    server.hub.shutdown(workspace.id, "test complete");
    await done;
    await listener.stop(true);
    await webapp.stop(true);
    await health.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
