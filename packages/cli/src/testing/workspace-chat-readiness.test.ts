import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./cli-test-support";

describe("pcd workspace chat readiness", () => {
  // A workspace turns ready before AgentAPI is waiting for input. Sending then
  // is rejected upstream and surfaces as an opaque 500.
  test("waits for agent input readiness before sending the first chat turn", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pocketcoder-cli-chat-wait-"));
    let sentWhileRunning = false;
    let statusReads = 0;
    const messages = [{ id: 0, role: "agent", content: "startup" }];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const route = `${request.method} ${url.pathname}`;
        const ready = statusReads >= 2;
        if (route === "GET /v1/workspaces/workspace-wait") {
          statusReads += 1;
          return Response.json({
            id: "workspace-wait",
            state: "ready",
            agent_state: ready ? "stable" : "running",
          });
        }
        if (route === "POST /v1/workspaces/workspace-wait/agent/message") {
          if (!ready) {
            sentWhileRunning = true;
            return new Response("message can only be sent when the agent is waiting for user input", { status: 500 });
          }
          const body = (await request.json()) as { content: string };
          messages.push({ id: 1, role: "user", content: body.content });
          messages.push({ id: 2, role: "agent", content: `reply: ${body.content}` });
          return Response.json({ ok: true });
        }
        if (route === "GET /v1/workspaces/workspace-wait/agent/messages") {
          return Response.json({ messages });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const result = await runCli(
        [
          "workspaces",
          "chat",
          "--id",
          "workspace-wait",
          "--message",
          "hello",
          "--json",
          "--poll-interval-ms",
          "100",
          "--response-timeout-seconds",
          "5",
        ],
        {
          env: {
            POCKETCODER_URL: server.url.origin,
            POCKETCODER_KEY: "chat-key",
            POCKETCODER_STATE_DIR: directory,
          },
        },
      );
      expect(sentWhileRunning).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("reply: hello");
    } finally {
      await server.stop(true);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
