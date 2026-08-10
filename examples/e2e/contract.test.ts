import { afterAll, describe, expect, test } from "bun:test";
import { runHarnessE2E } from "./contract";

describe("harness E2E contract", () => {
  let workspaceState = "queued";
  let messages: Array<{ role: string; content: string }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/v1/workspaces") {
        workspaceState = "queued";
        messages = [];
        setTimeout(() => {
          workspaceState = "ready";
        }, 20);
        return Response.json({ id: "example-workspace", state: workspaceState }, { status: 201 });
      }
      if (request.method === "GET" && url.pathname === "/v1/workspaces/example-workspace") {
        return Response.json({ id: "example-workspace", state: workspaceState });
      }
      if (request.method === "POST" && url.pathname === "/v1/workspaces/example-workspace/cancel") {
        workspaceState = "canceled";
        return Response.json({ id: "example-workspace", state: workspaceState });
      }
      if (url.pathname.endsWith("/agent/status")) {
        return Response.json({ status: "stable" });
      }
      if (request.method === "GET" && url.pathname.endsWith("/agent/messages")) {
        return Response.json({ messages });
      }
      if (request.method === "POST" && url.pathname.endsWith("/agent/message")) {
        const body = (await request.json()) as { content: string };
        messages.push({ role: "user", content: body.content });
        setTimeout(() => {
          messages.push({ role: "assistant", content: `echo: ${body.content}` });
        }, 20);
        return Response.json({ accepted: true });
      }
      return new Response("not found", { status: 404 });
    },
  });

  afterAll(() => server.stop(true));

  test("creates, converses, and cancels through the public contract", async () => {
    const report = await runHarnessE2E({
      baseUrl: `http://127.0.0.1:${server.port}`,
      key: "pkt_test",
      template: "echo-harness",
      prompt: "hello",
      expectedResponse: "echo: hello",
      readyTimeoutMs: 1000,
      messageTimeoutMs: 1000,
      pollIntervalMs: 10,
    });

    expect(report.workspaceId).toBe("example-workspace");
    expect(report.terminalState).toBe("canceled");
    expect(report.responseText).toContain("echo: hello");
  });
});
