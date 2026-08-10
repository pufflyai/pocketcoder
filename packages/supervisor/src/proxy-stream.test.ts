import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type {
  AgentFrame,
  ProxyRequest,
  TemplateService,
  TemplateServiceRoute,
} from "@pstdio/pocketcoder-contracts";
import { ProxyStreamCoordinator } from "./proxy-stream";

function request(deadlineMs = 1_000): ProxyRequest {
  return {
    request_id: randomUUID(),
    service: "agent",
    method: "GET",
    path: "/events",
    query: {},
    headers: { accept: "text/event-stream" },
    deadline_ms: deadlineMs,
  };
}

const service: TemplateService = {
  baseUrl: "http://127.0.0.1:3284",
  required: true,
  healthPath: "/status",
  routes: [],
};

function route(maxResponseBytes = 1_024): TemplateServiceRoute {
  return {
    method: "GET",
    path: "/events",
    query: [],
    maxRequestBytes: 65_536,
    maxResponseBytes,
    deadlineSeconds: 60,
    responseMode: "stream",
  };
}

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 1_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for stream frame");
    await Bun.sleep(1);
  }
}

describe("supervisor proxy stream", () => {
  test("waits for each matching acknowledgement before reading the next chunk", async () => {
    const frames: Array<{ type: AgentFrame["type"]; payload: Record<string, unknown> }> = [];
    const fetchImpl = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from("first"));
            controller.enqueue(Buffer.from("second"));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    const coordinator = new ProxyStreamCoordinator((type, payload) => {
      frames.push({ type, payload: payload as Record<string, unknown> });
      return true;
    }, fetchImpl);
    const relayRequest = request();
    const running = coordinator.relay(relayRequest, service, route());

    await waitFor(() => frames.filter((frame) => frame.type === "proxy_stream_chunk").length === 1);
    expect(frames.map((frame) => frame.type)).toEqual(["proxy_stream_start", "proxy_stream_chunk"]);
    coordinator.handleAck({ request_id: relayRequest.request_id, seq: 0 });
    await waitFor(() => frames.filter((frame) => frame.type === "proxy_stream_chunk").length === 2);
    coordinator.handleAck({ request_id: relayRequest.request_id, seq: 1 });
    await running;

    expect(frames.at(-1)).toMatchObject({
      type: "proxy_stream_end",
      payload: { request_id: relayRequest.request_id },
    });
    expect(coordinator.activeCount).toBe(0);
  });

  test("cancels the upstream reader and releases state", async () => {
    let canceled = false;
    const frames: Array<{ type: AgentFrame["type"]; payload: Record<string, unknown> }> = [];
    const fetchImpl = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from("pending"));
          },
          cancel() {
            canceled = true;
          },
        }),
      );
    const coordinator = new ProxyStreamCoordinator((type, payload) => {
      frames.push({ type, payload: payload as Record<string, unknown> });
      return true;
    }, fetchImpl);
    const relayRequest = request();
    const running = coordinator.relay(relayRequest, service, route());
    await waitFor(() => frames.some((frame) => frame.type === "proxy_stream_chunk"));

    await coordinator.handleCancel({
      request_id: relayRequest.request_id,
      reason: "downstream_closed",
    });
    await running;
    expect(canceled).toBe(true);
    expect(coordinator.activeCount).toBe(0);
    expect(frames.some((frame) => frame.type === "proxy_stream_end")).toBe(false);
  });

  test("ends a response that exceeds the declared cumulative byte cap", async () => {
    const frames: Array<{ type: AgentFrame["type"]; payload: Record<string, unknown> }> = [];
    const fetchImpl = async () => new Response("oversized");
    const coordinator = new ProxyStreamCoordinator((type, payload) => {
      frames.push({ type, payload: payload as Record<string, unknown> });
      return true;
    }, fetchImpl);
    await coordinator.relay(request(), service, route(4));
    expect(frames.at(-1)).toMatchObject({
      type: "proxy_stream_end",
      payload: { error_code: "too_large" },
    });
  });

  test("releases an unacknowledged chunk when the request deadline expires", async () => {
    const frames: Array<{ type: AgentFrame["type"]; payload: Record<string, unknown> }> = [];
    const fetchImpl = async () => new Response("waiting for ack");
    const coordinator = new ProxyStreamCoordinator((type, payload) => {
      frames.push({ type, payload: payload as Record<string, unknown> });
      return true;
    }, fetchImpl);

    await coordinator.relay(request(20), service, route());
    expect(frames.at(-1)).toMatchObject({
      type: "proxy_stream_end",
      payload: { error_code: "deadline" },
    });
    expect(coordinator.activeCount).toBe(0);
  });
});
