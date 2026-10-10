import { randomUUID } from "node:crypto";
import {
  HEADER_PROTOCOL,
  HEADER_REGISTRATION,
  HEADER_WORKSPACE,
  PROTOCOL_VERSION,
  type ServerFrame,
} from "@pstdio/pocketcoder-contracts";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { authed, createTestBody, createTestServer } from "../testing/test-server.test";

const createStore = createTestStoreFactory();
export const testPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);
export async function screenshotFixture() {
  const maximum = 3 * 4 * 1024 ** 2 + 65536;
  let baseUrl = "http://127.0.0.1:0";
  const options = {
    agentBaseUrl: baseUrl,
    readCapacity: async () => ({
      workspace: { bytes: maximum, files: 1 },
      principal: { bytes: maximum, files: 1 },
      instance: { bytes: maximum, files: 1 },
      freeDisk: { bytes: maximum, files: 1, headroomBytes: 0, headroomFiles: 0 },
    }),
  };
  const server = await createTestServer(await createStore(), {}, undefined, { screenshotOptions: options });
  const found = await server.store.getMachineKeyWithPrincipal(server.keyId);
  const template = await server.store.getTemplate("fixture-echo");
  if (!found || !template) throw new Error("Missing screenshot fixture.");
  await server.store.updatePrincipal(
    found.principal.id,
    [...found.principal.scopes, "display:view", "outputs:read"],
    ["*"],
  );
  await server.store.upsertTemplate({
    ...template,
    version: "2.0.0",
    digest: `sha256:${"f".repeat(64)}`,
    spec: { ...template.spec, display: { mode: "desktop" } },
  });
  const created = await server.app.request(
    "/v1/workspaces",
    authed(server.token, { method: "POST", headers: { "idempotency-key": randomUUID() }, body: createTestBody() }),
  );
  const { id } = (await created.json()) as { id: string };
  await server.scheduler.tick();
  const input = server.driver.inputFor(id);
  if (!input) throw new Error("Missing supervisor input.");
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, listener) =>
      new URL(request.url).pathname.startsWith("/v1/agent/")
        ? server.agentApp.fetch(request, listener)
        : server.app.fetch(request, listener),
    websocket: server.websocket,
  });
  baseUrl = `http://127.0.0.1:${listener.port}`;
  options.agentBaseUrl = baseUrl;
  const connectionId = randomUUID();
  let seq = 0;
  let grant: (frame: Extract<ServerFrame, { type: "screenshot_capture" }>["payload"]) => void = () => {};
  const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/v1/agent/connect`, {
    headers: {
      [HEADER_PROTOCOL]: String(PROTOCOL_VERSION),
      [HEADER_WORKSPACE]: id,
      [HEADER_REGISTRATION]: input.registration_secret,
    },
  } as unknown as string[]);
  function send(type: string, payload: unknown) {
    socket.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type,
        workspace_id: id,
        connection_id: connectionId,
        seq: seq++,
        sent_at: new Date().toISOString(),
        payload,
      }),
    );
  }
  socket.onopen = () =>
    send("registered", {
      agent_version: "test",
      template: { name: input.template_name, version: input.template_version, digest: input.template_digest },
      services: ["agent"],
      pid: 1,
    });
  socket.onmessage = (event) => {
    const frame = JSON.parse(String(event.data)) as ServerFrame;
    if (frame.type === "registered_ack") send("service_health", { service: "agent", health: "healthy" });
    if (frame.type === "screenshot_capture") grant(frame.payload);
  };
  const deadline = Date.now() + 3000;
  while ((await server.store.getWorkspace(id))?.state !== "ready") {
    if (Date.now() > deadline) throw new Error("Screenshot fixture readiness failed.");
    await Bun.sleep(10);
  }
  const client = new PocketCoderClient({ baseUrl, apiKey: server.token, maxRetries: 0 });
  return {
    server,
    client,
    id,
    baseUrl,
    async nextCapture() {
      const received = new Promise<Extract<ServerFrame, { type: "screenshot_capture" }>["payload"]>((resolve) => {
        grant = resolve;
      });
      const capture = client.displays.capture(id);
      void capture.catch(() => {});
      const payload = await received;
      return {
        payload,
        capture,
        upload: (bytes = testPng) =>
          fetch(payload.url, {
            method: "PUT",
            headers: { authorization: `Bearer ${payload.credential}`, "content-type": "image/png" },
            body: bytes,
          }),
      };
    },
    async close() {
      await server.screenshots?.close();
      socket.close();
      await listener.stop(true);
    },
  };
}
