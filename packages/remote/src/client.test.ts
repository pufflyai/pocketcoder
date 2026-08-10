import { describe, expect, test } from "bun:test";
import { RemoteAgentClient, serviceUrlFromEnvironment } from "./client";

describe("local Pi AgentAPI client", () => {
  test("publishes full live snapshots before completing from stable messages", async () => {
    const encoder = new TextEncoder();
    let eventsController!: ReadableStreamDefaultController<Uint8Array>;
    let finalMessage = "remote ready";
    const requests: string[] = [];
    const events = new ReadableStream<Uint8Array>({
      start(controller) {
        eventsController = controller;
        controller.enqueue(
          encoder.encode(
            `event: message_update\ndata: ${JSON.stringify({ id: 0, message: "remote ready", role: "agent", time: new Date().toISOString() })}\n\n`,
          ),
        );
      },
    });
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This fixture keeps the SSE and message ordering visible in one router.
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const request =
        input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
      const path = new URL(request.url).pathname;
      requests.push(`${request.method} ${path}`);
      if (request.method === "GET" && path.endsWith("/events")) {
        return new Response(events, { headers: { "content-type": "text/event-stream" } });
      }
      if (request.method === "GET" && path.endsWith("/messages")) {
        return Response.json({
          messages: [
            { id: 0, role: "agent", content: "remote ready" },
            ...(finalMessage === "remote ready"
              ? []
              : [{ id: 2, role: "agent", content: finalMessage }]),
          ],
        });
      }
      if (request.method === "GET" && path.endsWith("/changes")) {
        return Response.json({
          cursor: 1,
          changed: false,
          workspace: { agent_state: "stable" },
        });
      }
      if (request.method === "POST" && path.endsWith("/message")) {
        queueMicrotask(() => {
          for (const payload of [
            `event: status_change\ndata: ${JSON.stringify({ agent_type: "pi", status: "running" })}\n\n`,
            `event: message_update\ndata: ${JSON.stringify({ id: 2, message: "draft text", role: "agent", time: new Date().toISOString() })}\n\n`,
            `event: message_update\ndata: ${JSON.stringify({ id: 2, message: "rewritten final", role: "agent", time: new Date().toISOString() })}\n\n`,
          ]) {
            eventsController.enqueue(encoder.encode(payload));
          }
          finalMessage = "rewritten final";
          eventsController.enqueue(
            encoder.encode(
              `event: status_change\ndata: ${JSON.stringify({ agent_type: "pi", status: "stable" })}\n\n`,
            ),
          );
        });
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const client = new RemoteAgentClient(
      {
        serviceUrl: "http://pocketcoder.test/v1/workspaces/ws/agent",
        key: "pkt_example",
        timeoutMs: 1_000,
      },
      fetchImpl,
    );
    const snapshots: string[] = [];

    expect(await client.send("write", undefined, [], (snapshot) => snapshots.push(snapshot))).toBe(
      "rewritten final",
    );
    expect(snapshots).toEqual(["draft text", "rewritten final"]);
    expect(requests.indexOf("GET /v1/workspaces/ws/agent/events")).toBeLessThan(
      requests.indexOf("POST /v1/workspaces/ws/agent/message"),
    );
  });

  test("sends a turn and waits for the new remote agent response", async () => {
    let status = "stable";
    let cursor = 1;
    const messages = [{ id: 0, role: "agent", content: "remote ready" }];
    const requests: Request[] = [];
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This single fixture router keeps the turn state transitions visible.
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const request =
        input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path.endsWith("/messages")) {
        return Response.json({ messages });
      }
      if (request.method === "GET" && path.endsWith("/status")) {
        return Response.json({ status });
      }
      if (request.method === "GET" && path.endsWith("/changes")) {
        const after = Number(new URL(request.url).searchParams.get("after"));
        if (after === 0) {
          return Response.json({
            cursor,
            changed: true,
            workspace: { agent_state: status },
          });
        }
        status = "stable";
        cursor += 1;
        messages.push({ id: 2, role: "agent", content: "fixture contents" });
        return Response.json({
          cursor,
          changed: true,
          workspace: { agent_state: status },
        });
      }
      if (request.method === "POST" && path.endsWith("/message")) {
        status = "running";
        cursor += 1;
        messages.push({ id: 1, role: "user", content: "read the file" });
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const client = new RemoteAgentClient(
      {
        serviceUrl: "http://pocketcoder.test/v1/workspaces/ws/agent",
        key: "pkt_example",
        pollIntervalMs: 1,
        timeoutMs: 100,
      },
      fetchImpl,
    );

    expect(await client.send("read the file")).toBe("fixture contents");
    expect(await requests.at(-1)?.headers.get("authorization")).toBe("Bearer pkt_example");
    expect(requests.some((request) => new URL(request.url).pathname.endsWith("/changes"))).toBe(
      true,
    );
    expect(requests.some((request) => new URL(request.url).pathname.endsWith("/status"))).toBe(
      false,
    );
  });

  test("falls back to AgentAPI polling for a direct service URL", async () => {
    let status = "stable";
    const messages = [{ id: 0, role: "agent", content: "ready" }];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const request =
        input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path.endsWith("/messages")) {
        return Response.json({ messages });
      }
      if (request.method === "GET" && path.endsWith("/status")) {
        if (status === "running") {
          status = "stable";
          messages.push({ id: 2, role: "agent", content: "direct reply" });
        }
        return Response.json({ status });
      }
      if (request.method === "POST" && path.endsWith("/message")) {
        status = "running";
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const client = new RemoteAgentClient(
      {
        serviceUrl: "http://agentapi.test",
        key: "pkt_example",
        pollIntervalMs: 1,
        timeoutMs: 100,
      },
      fetchImpl,
    );

    expect(await client.send("hello")).toBe("direct reply");
  });
});

describe("local Pi AgentAPI stream lifecycle", () => {
  test("cancels the live event reader when the turn is aborted", async () => {
    let eventReaderCanceled = false;
    let submitted!: () => void;
    const messageSubmitted = new Promise<void>((resolve) => {
      submitted = resolve;
    });
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const request =
        input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
      const path = new URL(request.url).pathname;
      if (path.endsWith("/messages")) {
        return Response.json({ messages: [{ id: 0, role: "agent", content: "ready" }] });
      }
      if (path.endsWith("/changes")) {
        return Response.json({
          cursor: 1,
          workspace: { agent_state: "stable" },
        });
      }
      if (path.endsWith("/events")) {
        return new Response(
          new ReadableStream({
            cancel() {
              eventReaderCanceled = true;
            },
          }),
        );
      }
      if (request.method === "POST" && path.endsWith("/message")) {
        submitted();
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const client = new RemoteAgentClient(
      { serviceUrl: "http://pocketcoder.test/v1/workspaces/ws/agent", key: "pkt_example" },
      fetchImpl,
    );
    const controller = new AbortController();
    const result = client.send("wait", controller.signal);
    await messageSubmitted;
    controller.abort(new Error("user canceled"));

    await expect(result).rejects.toThrow("user canceled");
    await Bun.sleep(0);
    expect(eventReaderCanceled).toBe(true);
  });

  test("derives the relay URL from the workspace", () => {
    expect(
      serviceUrlFromEnvironment({
        POCKETCODER_URL: "http://localhost:7080/",
        POCKETCODER_KEY: "pkt_example",
        POCKETCODER_WORKSPACE_ID: "workspace id",
      }),
    ).toEqual({
      serviceUrl: "http://localhost:7080/v1/workspaces/workspace%20id/agent",
      key: "pkt_example",
    });
  });
});
