import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./cli-test-support";

const doctorWorkspaceId = "33333333-3333-4333-8333-333333333333";
const statusOnlyWorkspaceId = "44444444-4444-4444-8444-444444444444";

function doctorWorkspace(
  id: string,
  state: "ready" | "canceled",
  agentState: "stable" | "running" | "unknown" = state === "ready" ? "stable" : "unknown",
) {
  return {
    id,
    external_id: `external-${id}`,
    template: { name: "fixture-echo", version: "1", digest: "sha256:template" },
    state,
    reason_code: null,
    agent_state: agentState,
    change_cursor: 1,
    provider_kind: null,
    provisioning_mode: null,
    network: { state: state === "ready" ? "ready" : "starting" },
    health: {},
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    connected_at: state === "ready" ? "2026-01-01T00:00:01Z" : null,
    ready_at: state === "ready" ? "2026-01-01T00:00:02Z" : null,
    deadline_at: "2026-01-01T01:00:00Z",
    terminal_at: state === "canceled" ? "2026-01-01T00:00:03Z" : null,
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
    failure: null,
  };
}

describe("pcd doctor", () => {
  test.each([0, 2])(
    "doctor waits through %i running statuses before sending and cancels",
    async (runningReads) => {
      let diagnosticPrompt = "";
      let canceled = false;
      let agentReads = 0;
      // The agent reports itself waiting for input only after `runningReads`
      // observations, mirroring AgentAPI's startup window.
      const agentState = () => (agentReads > runningReads ? "stable" : "running");
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This single fixture router makes every doctor request explicit.
        async fetch(request) {
          const url = new URL(request.url);
          if (request.method === "POST" && url.pathname === "/v1/workspaces") {
            expect(request.headers.get("idempotency-key")).toStartWith("doctor-");
            return Response.json(doctorWorkspace(doctorWorkspaceId, "ready"), { status: 201 });
          }
          if (request.method === "GET" && url.pathname === `/v1/workspaces/${doctorWorkspaceId}`) {
            agentReads += 1;
            return Response.json(doctorWorkspace(doctorWorkspaceId, "ready", agentState()));
          }
          if (
            request.method === "GET" &&
            url.pathname === `/v1/workspaces/${doctorWorkspaceId}/changes`
          ) {
            agentReads += 1;
            return Response.json({
              cursor: agentReads,
              changed: true,
              workspace: doctorWorkspace(doctorWorkspaceId, "ready", agentState()),
            });
          }
          if (
            request.method === "GET" &&
            url.pathname === `/v1/workspaces/${doctorWorkspaceId}/agent/status`
          ) {
            return Response.json({ status: agentState() });
          }
          if (
            request.method === "POST" &&
            url.pathname === `/v1/workspaces/${doctorWorkspaceId}/agent/message`
          ) {
            if (agentState() !== "stable") {
              return new Response(
                "message can only be sent when the agent is waiting for user input",
                { status: 500 },
              );
            }
            const body = (await request.json()) as { content: string };
            diagnosticPrompt = body.content;
            return Response.json({ ok: true });
          }
          if (
            request.method === "GET" &&
            url.pathname === `/v1/workspaces/${doctorWorkspaceId}/agent/messages`
          ) {
            return Response.json({
              messages: [{ id: 1, role: "assistant", content: diagnosticPrompt }],
            });
          }
          if (
            request.method === "POST" &&
            url.pathname === `/v1/workspaces/${doctorWorkspaceId}/cancel`
          ) {
            canceled = true;
            return Response.json(doctorWorkspace(doctorWorkspaceId, "canceled"));
          }
          return new Response("not found", { status: 404 });
        },
      });
      try {
        const result = await runCli(["doctor", "--template", "fixture-echo"], {
          env: {
            POCKETCODER_URL: server.url.origin,
            POCKETCODER_KEY: "doctor-key",
          },
        });
        expect(result.exitCode).toBe(0);
        expect(result.output).toContain("doctor: correlated agent response received");
        expect(result.output).toContain("doctor: ok");
        expect(canceled).toBe(true);
      } finally {
        await server.stop(true);
      }
    },
  );

  test.each([
    ["stable", "agent message probe failed (404)"],
    ["running", "was still running after 1000ms"],
    ["unknown", "agent status probe returned unknown status"],
  ] as const)(
    "doctor rejects a %s status-only harness and still cancels",
    async (status, error) => {
      let canceled = false;
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          const url = new URL(request.url);
          if (request.method === "POST" && url.pathname === "/v1/workspaces") {
            return Response.json(doctorWorkspace(statusOnlyWorkspaceId, "ready"), { status: 201 });
          }
          if (
            request.method === "GET" &&
            url.pathname === `/v1/workspaces/${statusOnlyWorkspaceId}`
          ) {
            return Response.json(doctorWorkspace(statusOnlyWorkspaceId, "ready", status));
          }
          if (
            request.method === "GET" &&
            url.pathname === `/v1/workspaces/${statusOnlyWorkspaceId}/changes`
          ) {
            return Response.json({
              cursor: 1,
              changed: false,
              workspace: doctorWorkspace(statusOnlyWorkspaceId, "ready", status),
            });
          }
          if (
            request.method === "GET" &&
            url.pathname === `/v1/workspaces/${statusOnlyWorkspaceId}/agent/status`
          ) {
            return Response.json({ status });
          }
          if (
            request.method === "POST" &&
            url.pathname === `/v1/workspaces/${statusOnlyWorkspaceId}/cancel`
          ) {
            canceled = true;
            return Response.json(doctorWorkspace(statusOnlyWorkspaceId, "canceled"));
          }
          return new Response("not found", { status: 404 });
        },
      });
      try {
        const result = await runCli(
          ["doctor", "--template", "status-only", "--turn-timeout-seconds", "1"],
          {
            env: {
              POCKETCODER_URL: server.url.origin,
              POCKETCODER_KEY: "doctor-key",
            },
          },
        );
        expect(result.exitCode).toBe(1);
        expect(result.output).toContain(error);
        expect(canceled).toBe(true);
      } finally {
        await server.stop(true);
      }
    },
  );
});

describe("pcd environment", () => {
  test("loads .env from the nearest project directory", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pocketcoder-cli-"));
    const nested = join(directory, "nested");
    mkdirSync(nested);
    const authorizations: Array<string | null> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        authorizations.push(request.headers.get("authorization"));
        return Response.json({ items: [], next_cursor: null });
      },
    });
    try {
      writeFileSync(
        join(directory, ".env"),
        `POCKETCODER_URL=${server.url.origin}\nPOCKETCODER_KEY=from-dotenv\n`,
      );

      const result = await runCli(["workspaces", "list"], { cwd: nested });

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("(no workspaces)");
      expect(authorizations).toEqual(["Bearer from-dotenv"]);
    } finally {
      await server.stop(true);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps exported environment variables above .env values", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pocketcoder-cli-"));
    const authorizations: Array<string | null> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        authorizations.push(request.headers.get("authorization"));
        return Response.json({ items: [], next_cursor: null });
      },
    });
    try {
      writeFileSync(
        join(directory, ".env"),
        `POCKETCODER_URL=${server.url.origin}\nPOCKETCODER_KEY=from-dotenv\n`,
      );

      const result = await runCli(["workspaces", "list"], {
        cwd: directory,
        env: { POCKETCODER_KEY: "from-shell" },
      });

      expect(result.exitCode).toBe(0);
      expect(authorizations).toEqual(["Bearer from-shell"]);
    } finally {
      await server.stop(true);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("supports explicit work directories and environment files", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pocketcoder-cli-"));
    const invocationDirectory = mkdtempSync(join(tmpdir(), "pocketcoder-cli-cwd-"));
    const authorizations: Array<string | null> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        authorizations.push(request.headers.get("authorization"));
        return Response.json({ items: [], next_cursor: null });
      },
    });
    try {
      writeFileSync(
        join(directory, "staging.env"),
        `POCKETCODER_URL=${server.url.origin}\nPOCKETCODER_KEY=from-explicit-file\n`,
      );

      const result = await runCli(
        ["--workdir", directory, "--env-file", "staging.env", "workspaces", "list"],
        { cwd: invocationDirectory },
      );

      expect(result.exitCode).toBe(0);
      expect(authorizations).toEqual(["Bearer from-explicit-file"]);
    } finally {
      await server.stop(true);
      rmSync(directory, { recursive: true, force: true });
      rmSync(invocationDirectory, { recursive: true, force: true });
    }
  });
});
