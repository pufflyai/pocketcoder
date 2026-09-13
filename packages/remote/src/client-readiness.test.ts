import { describe, expect, test } from "bun:test";
import { RemoteAgentClient } from "./client";

// AgentAPI rejects a user message unless it is waiting for input. A workspace
// reports itself ready before that point, so the client must wait.
describe("remote agent input readiness", () => {
  test("waits for a stable agent before submitting the prompt", async () => {
    let statusReads = 0;
    let sentWhileRunning = false;
    const messages: Array<{ id: number; role: string; content: string }> = [];
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This single fixture router keeps the startup window and the send guard visible together.
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const request =
        input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
      const path = new URL(request.url).pathname;
      const ready = statusReads >= 2;
      if (request.method === "GET" && path.endsWith("/events")) {
        return new Response("no events", { status: 404 });
      }
      if (request.method === "GET" && path.endsWith("/status")) {
        statusReads += 1;
        return Response.json({ status: ready ? "stable" : "running" });
      }
      if (request.method === "GET" && path.endsWith("/messages")) {
        return Response.json({ messages });
      }
      if (request.method === "POST" && path.endsWith("/message")) {
        if (!ready) {
          sentWhileRunning = true;
          return new Response("message can only be sent when the agent is waiting for user input", {
            status: 500,
          });
        }
        const body = (await request.json()) as { content: string };
        messages.push({ id: 1, role: "user", content: body.content });
        messages.push({ id: 2, role: "agent", content: `reply: ${body.content}` });
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const client = new RemoteAgentClient(
      { serviceUrl: "http://agent.test", key: "pkt_example", pollIntervalMs: 5, timeoutMs: 5_000 },
      fetchImpl,
    );

    const reply = await client.send("hello");

    expect(sentWhileRunning).toBe(false);
    expect(reply).toBe("reply: hello");
  });

  test("fails with a clear error when the agent never accepts input", async () => {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const request =
        input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path.endsWith("/events")) {
        return new Response("no events", { status: 404 });
      }
      if (request.method === "GET" && path.endsWith("/status")) {
        return Response.json({ status: "running" });
      }
      if (request.method === "GET" && path.endsWith("/messages")) {
        return Response.json({ messages: [] });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const client = new RemoteAgentClient(
      {
        serviceUrl: "http://agent.test",
        key: "pkt_example",
        pollIntervalMs: 5,
        readyTimeoutMs: 50,
        timeoutMs: 5_000,
      },
      fetchImpl,
    );

    const failure = await client.send("hello").catch((error: unknown) => error);

    expect(String(failure)).toContain("was still running after 50ms");
  });
});
