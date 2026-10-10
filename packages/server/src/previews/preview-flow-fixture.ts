import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTemplateManifest } from "@pstdio/pocketcoder-contracts";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { supervise } from "@pstdio/pocketcoder-supervisor";
import { createTestServer } from "../testing/test-server.test";

const createStore = createTestStoreFactory();

export async function createPreviewFlow() {
  const captured: Headers[] = [];
  const socketOrigins: (string | null)[] = [];
  let uploadRequests = 0;
  const webapp = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      captured.push(request.headers);
      if (server.upgrade(request)) {
        socketOrigins.push(request.headers.get("origin"));
        return;
      }
      const path = new URL(request.url).pathname;
      if (path === "/framing")
        return new Response("protected", {
          headers: {
            "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
            "x-frame-options": "DENY",
          },
        });
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
  const publicViews = {
    apiOrigin: "https://api.example.org",
    origin: "https://views.example.net",
    parents: ["https://app.example.org"],
    trustedIngress: ["127.0.0.1"],
  };
  const server = await createTestServer(await createStore(), {}, undefined, { publicViews });
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
      services: {
        agent: { baseUrl: `http://127.0.0.1:${health.port}`, routes: [{ method: "GET", path: "/status" }] },
      },
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
  return {
    captured,
    socketOrigins,
    server,
    client,
    workspace,
    publicViews,
    baseUrl,
    get uploadRequests() {
      return uploadRequests;
    },
    previewPort: Number(webapp.port),
    publicClient: new PocketCoderClient({
      baseUrl: publicViews.apiOrigin,
      apiKey: server.token,
      fetch: (async (input, init) => server.app.fetch(new Request(String(input), init))) as typeof fetch,
    }),
    async close() {
      server.hub.shutdown(workspace.id, "test complete");
      await done;
      await listener.stop(true);
      await webapp.stop(true);
      await health.stop(true);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
