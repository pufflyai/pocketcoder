import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort, runCli } from "./cli-test-support";

describe("pcd server lifecycle", () => {
  test("starts, reports, and stops only the managed server process", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pocketcoder-cli-server-"));
    const port = freePort();
    const env = {
      POCKETCODER_HOST: "127.0.0.1",
      POCKETCODER_PORT: String(port),
      POCKETCODER_STATE_DIR: directory,
      POCKETCODER_STORE: "memory",
    };
    try {
      const started = await runCli(["server", "start"], { env });
      expect(started.exitCode).toBe(0);
      expect(started.output).toContain("pocketcoder-server started");

      const status = await runCli(["server", "status", "--json"], { env });
      expect(status.exitCode).toBe(0);
      expect(status.output).toContain('"state": "running"');

      const health = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(health.status).toBe(200);

      const stopped = await runCli(["server", "stop"], { env });
      expect(stopped.exitCode).toBe(0);
      expect(stopped.output).toContain("pocketcoder-server stopped");

      const after = await runCli(["server", "status"], { env });
      expect(after.exitCode).toBe(1);
      expect(after.output).toContain("no managed server state");
    } finally {
      await runCli(["server", "stop"], { env }).catch(() => {});
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("refuses to stop a PID whose process identity does not match", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pocketcoder-cli-server-state-"));
    try {
      writeFileSync(
        join(directory, "server.json"),
        JSON.stringify({
          version: 1,
          pid: process.pid,
          instanceToken: "not-present-in-the-process-command",
          url: "http://127.0.0.1:1",
          startedAt: new Date().toISOString(),
          configFingerprint: "test",
          logPath: join(directory, "server.log"),
        }),
      );
      const stopped = await runCli(["server", "stop"], {
        env: { POCKETCODER_STATE_DIR: directory },
      });
      expect(stopped.exitCode).toBe(1);
      expect(stopped.output).toContain("process identity does not match");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("pcd workspace workflows", () => {
  const waitingWorkspaceId = "11111111-1111-4111-8111-111111111111";
  const failedWorkspaceId = "22222222-2222-4222-8222-222222222222";
  function workspaceResource(
    id: string,
    state: "queued" | "ready" | "failed",
    changeCursor: number,
  ) {
    return {
      id,
      external_id: `external-${id}`,
      template: { name: "pi-harness", version: "1", digest: "sha256:template" },
      state,
      reason_code: state === "failed" ? "launch_failed" : null,
      agent_state: state === "ready" ? "stable" : "unknown",
      change_cursor: changeCursor,
      provider_kind: null,
      provisioning_mode: null,
      network: { state: state === "ready" ? "ready" : "starting" },
      health: {},
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      connected_at: state === "ready" ? "2026-01-01T00:00:01Z" : null,
      ready_at: state === "ready" ? "2026-01-01T00:00:02Z" : null,
      deadline_at: "2026-01-01T01:00:00Z",
      terminal_at: state === "failed" ? "2026-01-01T00:00:02Z" : null,
      metadata: {},
      origin_workspace_id: null,
      restored_from_checkpoint_id: null,
      source: null,
      persistence: {
        enabled: false,
        conversation_restore: "filesystem_only",
        conversation_resume: { status: "unsupported", reason: "filesystem_only" },
        latest_checkpoint_id: null,
      },
      outputs: {},
      failure:
        state === "failed"
          ? {
              reason_code: "launch_failed",
              log_tail: "docker image is unavailable",
              log_tail_truncated: false,
              last_log_seq: 1,
            }
          : null,
    };
  }

  test("creates a workspace and waits for the durable ready change", async () => {
    let changeReads = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/v1/workspaces") {
          return Response.json(workspaceResource(waitingWorkspaceId, "queued", 1), { status: 201 });
        }
        if (
          request.method === "GET" &&
          url.pathname === `/v1/workspaces/${waitingWorkspaceId}/changes`
        ) {
          changeReads += 1;
          expect(url.searchParams.get("after")).toBe("1");
          return Response.json({
            cursor: 2,
            changed: true,
            workspace: workspaceResource(waitingWorkspaceId, "ready", 2),
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const result = await runCli(
        [
          "workspaces",
          "create",
          "--template",
          "pi-harness",
          "--wait",
          "--json",
          "--wait-timeout-seconds",
          "2",
        ],
        {
          env: {
            POCKETCODER_URL: server.url.origin,
            POCKETCODER_KEY: "wait-key",
          },
        },
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.output)).toMatchObject({
        id: waitingWorkspaceId,
        state: "ready",
      });
      expect(changeReads).toBe(1);
    } finally {
      await server.stop(true);
    }
  });

  test("prints bounded launch failure evidence while waiting", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/v1/workspaces") {
          return Response.json(workspaceResource(failedWorkspaceId, "queued", 1), { status: 201 });
        }
        if (url.pathname.endsWith("/changes")) {
          return Response.json({
            cursor: 2,
            changed: true,
            workspace: workspaceResource(failedWorkspaceId, "failed", 2),
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const result = await runCli(["workspaces", "create", "--template", "pi-harness", "--wait"], {
        env: {
          POCKETCODER_URL: server.url.origin,
          POCKETCODER_KEY: "wait-key",
        },
      });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("launch_failed");
      expect(result.output).toContain("docker image is unavailable");
    } finally {
      await server.stop(true);
    }
  });

  test("sends a chat turn and prints the correlated agent response", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pocketcoder-cli-chat-"));
    let prompt = "";
    let status = "stable";
    let statusReads = 0;
    const messages = [
      { id: 0, role: "agent", content: "startup" },
      { id: 1, role: "user", content: "old prompt" },
      { id: 2, role: "agent", content: "old reply" },
    ];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const route = `${request.method} ${url.pathname}`;
        if (route === "GET /v1/workspaces/workspace-chat") {
          statusReads += 1;
          if (status === "running" && statusReads > 2) {
            messages.push({ id: 4, role: "agent", content: `reply: ${prompt}` });
            status = "stable";
          }
          return Response.json({
            id: "workspace-chat",
            state: "ready",
            agent_state: status,
          });
        }
        if (route === "POST /v1/workspaces/workspace-chat/agent/message") {
          const body = (await request.json()) as { content: string };
          prompt = body.content;
          status = "running";
          messages.push({ id: 3, role: "user", content: prompt });
          return Response.json({ ok: true });
        }
        if (route === "GET /v1/workspaces/workspace-chat/agent/messages") {
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
          "workspace-chat",
          "--message",
          "hello",
          "--json",
          "--poll-interval-ms",
          "100",
          "--response-timeout-seconds",
          "2",
        ],
        {
          env: {
            POCKETCODER_URL: server.url.origin,
            POCKETCODER_KEY: "chat-key",
            POCKETCODER_STATE_DIR: directory,
          },
        },
      );
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('"role":"agent"');
      expect(result.output).toContain("reply: hello");
      expect(result.output).not.toContain("startup");
      expect(result.output).not.toContain("old reply");
    } finally {
      await server.stop(true);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
