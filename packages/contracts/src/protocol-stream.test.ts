import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  AgentFrameSchema,
  PROTOCOL_VERSION,
  PROXY_STREAM_CHUNK_BYTES,
  ServerFrameSchema,
  STREAMING_MIN_PROTOCOL_VERSION,
} from "./protocol";
import { parseTemplateManifest } from "./template";
import { templateServices } from "./template-runtime";
import { ServiceRouteSchema } from "./template-schema";

const envelope = {
  v: PROTOCOL_VERSION,
  workspace_id: randomUUID(),
  connection_id: randomUUID(),
  seq: 1,
  sent_at: new Date().toISOString(),
};

describe("streamed relay contracts", () => {
  test("defaults existing routes to buffered and declares AgentAPI events as streamed", () => {
    expect(ServiceRouteSchema.parse({ method: "GET", path: "/status" }).responseMode).toBe(
      "buffered",
    );
    const native = parseTemplateManifest({
      apiVersion: "pocketcoder.dev/v1alpha1",
      kind: "Template",
      metadata: { name: "native-stream" },
      spec: {
        version: "1.0.0",
        image: `example.test/native@sha256:${"a".repeat(64)}`,
        agent: { command: ["pi"], type: "pi" },
        resources: { cpu: "1", memory: "512Mi" },
      },
    });
    const eventRoute = templateServices(native.manifest.spec).agent?.routes.find(
      (route) => route.path === "/events",
    );
    expect(eventRoute).toMatchObject({ method: "GET", responseMode: "stream" });
  });

  test("validates ordered stream lifecycle and flow-control frames", () => {
    const requestId = randomUUID();
    for (const frame of [
      {
        ...envelope,
        type: "proxy_stream_start",
        payload: {
          request_id: requestId,
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      },
      {
        ...envelope,
        type: "proxy_stream_chunk",
        payload: { request_id: requestId, seq: 0, content_b64: "ZGF0YQ==" },
      },
      {
        ...envelope,
        type: "proxy_stream_end",
        payload: { request_id: requestId },
      },
    ]) {
      expect(AgentFrameSchema.safeParse(frame).success).toBe(true);
    }
    for (const frame of [
      {
        ...envelope,
        type: "proxy_stream_ack",
        payload: { request_id: requestId, seq: 0 },
      },
      {
        ...envelope,
        type: "proxy_stream_cancel",
        payload: { request_id: requestId, reason: "downstream_closed" },
      },
    ]) {
      expect(ServerFrameSchema.safeParse(frame).success).toBe(true);
    }
    expect(STREAMING_MIN_PROTOCOL_VERSION).toBe(5);
    expect(PROXY_STREAM_CHUNK_BYTES).toBeLessThan(1_048_576);
  });
});
