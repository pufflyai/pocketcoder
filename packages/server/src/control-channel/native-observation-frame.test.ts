import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestOpaque } from "@pstdio/pocketcoder-auth";
import {
  digestOf,
  HEADER_PROTOCOL,
  HEADER_RECONNECT,
  HEADER_WORKSPACE,
  PROTOCOL_VERSION,
  ProducerObservationSchema,
} from "@pstdio/pocketcoder-contracts";
import { executionFixture, serviceExecutionTemplate } from "@pstdio/pocketcoder-db/testing";
import { DockerDriver } from "@pstdio/pocketcoder-drivers";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { relayProxyRequest, SessionProducer } from "@pstdio/pocketcoder-supervisor/testing";
import { buildServer } from "../app";
import { execSpecOf } from "./ws-auth";

test.each([2, 8])("a native observation with %s large tool results crosses the real control socket", async (count) => {
  const f = await executionFixture(serviceExecutionTemplate);
  const directory = await mkdtemp(join(tmpdir(), "pc-observation-frame-"));
  const { fingerprint: _, ...base } = f.acceptance();
  const facts = { ...base, operation: "message", input: { message: "large results" } };
  const acceptance = { ...facts, fingerprint: digestOf(facts) };
  const input = {
    acceptance,
    conversationIdentity: {
      schema: "pocketcoder.conversation/v2" as const,
      authority: "external" as const,
      conversation_id: randomUUID(),
      request_id: acceptance.execution.requestId,
      turn_id: acceptance.execution.requestId,
      request_fingerprint: acceptance.fingerprint.slice(7),
    },
  };
  const producer = new SessionProducer(directory, async ({ emit }) => {
    for (let i = 0; i < count; i++)
      emit(`tool-${i}`, "tool", [
        {
          type: "tool",
          call_id: `call-${i}`,
          name: "bash",
          status: "completed",
          input: { command: "fixture" },
          output: { content: [{ type: "text", text: "x".repeat(200 * 1024) }] },
          output_text: "x".repeat(200 * 1024),
        },
      ]);
  });
  await producer.accept(input);
  let observation = await producer.lookup(input.acceptance.execution);
  while (observation.phase !== "terminal") {
    await Bun.sleep(5);
    observation = await producer.lookup(input.acceptance.execution);
  }
  const body = JSON.stringify(ProducerObservationSchema.parse(observation));
  expect(Buffer.byteLength(body)).toBeGreaterThan(786432);
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(body, { headers: { "content-type": "application/json" } }),
  });
  const controller = buildServer({
    store: f.store,
    driver: new DockerDriver(),
    limits: DEFAULT_LIMITS,
    pepper: "frame-test",
    workspaceServerUrl: "http://127.0.0.1:0",
  });
  await f.store.updateWorkspace(f.id, { reconnectDigest: digestOpaque("frame-test", "reconnect") }, new Date());
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: controller.agentApp.fetch,
    websocket: controller.websocket,
  });
  const row = await f.store.getWorkspace(f.id);
  if (!row) throw new Error("Workspace missing");
  const exec = execSpecOf(row, null, "provider_installed");
  exec.services = {
    session: {
      baseUrl: upstream.url.toString(),
      required: true,
      healthPath: "/",
      routes: [
        {
          method: "POST",
          path: "/lookup",
          query: [],
          responseMode: "buffered",
          maxRequestBytes: 65536,
          maxResponseBytes: 8 * 1024 * 1024,
          deadlineSeconds: 2,
        },
      ],
    },
  };
  const connectionId = randomUUID();
  let sequence = 0;
  const socket = new WebSocket(`${server.url.toString().replace("http:", "ws:")}v1/agent/connect`, {
    headers: { [HEADER_PROTOCOL]: String(PROTOCOL_VERSION), [HEADER_WORKSPACE]: f.id, [HEADER_RECONNECT]: "reconnect" },
  } as unknown as string[]);
  const send = (type: string, payload: unknown) => {
    socket.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type,
        workspace_id: f.id,
        connection_id: connectionId,
        seq: sequence++,
        sent_at: new Date().toISOString(),
        payload,
      }),
    );
    return true;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () =>
        send("registered", {
          agent_version: "native-frame-test",
          template: { name: "fixture", version: "1.0.0", digest: row.templateDigest },
          services: [],
          pid: 1,
        });
      socket.onerror = () => reject(new Error("Control socket failed"));
      socket.onclose = () => reject(new Error("Control socket closed"));
      socket.onmessage = (event) => {
        const frame = JSON.parse(String(event.data));
        if (frame.type === "registered_ack") resolve();
        if (frame.type === "proxy_request")
          void relayProxyRequest(frame.payload, {
            exec: () => exec,
            isQuiescing: () => false,
            send,
            relayStream: async () => {
              throw new Error("Expected buffered native observation");
            },
          });
      };
    });
    const reply = await controller.hub.relay(f.id, {
      service: "session",
      method: "POST",
      path: "/lookup",
      query: {},
      headers: {},
      body_b64: Buffer.from("{}").toString("base64"),
      deadline_ms: 2000,
    });
    expect(reply.error_code).toBeUndefined();
    expect(reply.status).toBe(200);
    expect(Buffer.from(reply.body_b64 ?? "", "base64").toString()).toBe(body);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  } finally {
    socket.close();
    await server.stop(true);
    await upstream.stop(true);
    await f.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
