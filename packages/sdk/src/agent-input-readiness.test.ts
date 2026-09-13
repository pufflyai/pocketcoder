import { describe, expect, test } from "bun:test";
import type { WorkspaceResource } from "@pstdio/pocketcoder-contracts";
import { AgentNotReadyError, PocketCoderClient, WorkspaceTerminalError } from "./index";

const WORKSPACE = "44444444-4444-4444-8444-444444444444";

function workspace(overrides: Partial<WorkspaceResource> = {}): WorkspaceResource {
  const state = overrides.state ?? "ready";
  return {
    id: WORKSPACE,
    external_id: "readiness",
    template: { name: "pi", version: "1", digest: "sha256:pi" },
    state,
    reason_code: null,
    agent_state: "running",
    change_cursor: 1,
    provider_kind: "docker",
    provisioning_mode: "cold",
    network: { state: "ready" },
    health: {},
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    connected_at: "2026-01-01T00:00:00Z",
    ready_at: "2026-01-01T00:00:00Z",
    deadline_at: "2026-01-01T01:00:00Z",
    terminal_at: ["preserved", "failed", "canceled", "expired", "succeeded"].includes(state)
      ? "2026-01-01T00:10:00Z"
      : null,
    metadata: {},
    origin_workspace_id: null,
    restored_from_checkpoint_id: null,
    source: null,
    persistence: {
      enabled: true,
      conversation_restore: "supported",
      conversation_resume: { status: "supported", reason: null },
      latest_checkpoint_id: null,
    },
    outputs: {},
    failure: null,
    ...overrides,
  };
}

function fixtureClient(route: (request: Request) => Response | Promise<Response>) {
  const paths: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request =
      input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    paths.push(`${request.method} ${new URL(request.url).pathname}`);
    return await route(request);
  }) as typeof fetch;
  const client = new PocketCoderClient(
    { baseUrl: "http://pocketcoder.test/", apiKey: "pkt_example" },
    fetchImpl,
  );
  return { client, paths };
}

describe("waitForAgentInput", () => {
  test("returns on the first read when the agent is already waiting for input", async () => {
    const { client, paths } = fixtureClient((request) => {
      const url = new URL(request.url);
      if (url.pathname === `/v1/workspaces/${WORKSPACE}`) {
        return Response.json(workspace({ agent_state: "stable" }));
      }
      return new Response("unexpected", { status: 404 });
    });

    const ready = await client.workspaces.waitForAgentInput(WORKSPACE, 5_000);

    expect(ready.agent_state).toBe("stable");
    // A stable agent must not pay for a long-poll that would block until the
    // change cursor moves.
    expect(paths).toEqual([`GET /v1/workspaces/${WORKSPACE}`]);
  });

  test("long-polls changes while the agent is still starting up", async () => {
    let changeReads = 0;
    const { client, paths } = fixtureClient((request) => {
      const url = new URL(request.url);
      if (url.pathname === `/v1/workspaces/${WORKSPACE}`) {
        return Response.json(workspace({ agent_state: "running" }));
      }
      if (url.pathname === `/v1/workspaces/${WORKSPACE}/changes`) {
        changeReads += 1;
        return Response.json({
          cursor: changeReads + 1,
          changed: true,
          workspace: workspace({
            agent_state: changeReads < 2 ? "running" : "stable",
            change_cursor: changeReads + 1,
          }),
        });
      }
      return new Response("unexpected", { status: 404 });
    });

    const ready = await client.workspaces.waitForAgentInput(WORKSPACE, 5_000);

    expect(ready.agent_state).toBe("stable");
    expect(changeReads).toBe(2);
    expect(paths.at(0)).toBe(`GET /v1/workspaces/${WORKSPACE}`);
  });

  test("fails with a named error when the agent never becomes ready", async () => {
    const { client } = fixtureClient((request) => {
      const url = new URL(request.url);
      if (url.pathname === `/v1/workspaces/${WORKSPACE}`) {
        return Response.json(workspace({ agent_state: "running" }));
      }
      if (url.pathname === `/v1/workspaces/${WORKSPACE}/changes`) {
        return Response.json({
          cursor: 1,
          changed: false,
          workspace: workspace({ agent_state: "running" }),
        });
      }
      return new Response("unexpected", { status: 404 });
    });

    const failure = await client.workspaces.waitForAgentInput(WORKSPACE, 1).catch((e) => e);

    expect(failure).toBeInstanceOf(AgentNotReadyError);
    expect((failure as AgentNotReadyError).agentState).toBe("running");
    expect((failure as AgentNotReadyError).workspaceId).toBe(WORKSPACE);
  });

  test("surfaces a terminal workspace instead of waiting out the timeout", async () => {
    const { client } = fixtureClient((request) => {
      const url = new URL(request.url);
      if (url.pathname === `/v1/workspaces/${WORKSPACE}`) {
        return Response.json(
          workspace({ agent_state: "unknown", state: "failed", reason_code: "child_crash" }),
        );
      }
      return new Response("unexpected", { status: 404 });
    });

    const failure = await client.workspaces.waitForAgentInput(WORKSPACE, 5_000).catch((e) => e);

    expect(failure).toBeInstanceOf(WorkspaceTerminalError);
  });
});

describe("agent.sendMessage", () => {
  // Upstream AgentAPI rejects a user message unless the agent is waiting for
  // input, and the relay surfaces that rejection as an opaque HTTP 500.
  test("waits for input readiness before posting the message", async () => {
    let reads = 0;
    let sentWhileRunning = false;
    let delivered = "";
    const { client } = fixtureClient(async (request) => {
      const url = new URL(request.url);
      const ready = reads >= 2;
      if (url.pathname === `/v1/workspaces/${WORKSPACE}`) {
        reads += 1;
        return Response.json(workspace({ agent_state: "running" }));
      }
      if (url.pathname === `/v1/workspaces/${WORKSPACE}/changes`) {
        reads += 1;
        return Response.json({
          cursor: reads,
          changed: true,
          workspace: workspace({ agent_state: reads >= 2 ? "stable" : "running" }),
        });
      }
      if (url.pathname === `/v1/workspaces/${WORKSPACE}/agent/message`) {
        if (!ready) {
          sentWhileRunning = true;
          return new Response("message can only be sent when the agent is waiting for user input", {
            status: 500,
          });
        }
        delivered = ((await request.json()) as { content: string }).content;
        return Response.json({ ok: true });
      }
      return new Response("unexpected", { status: 404 });
    });

    await client.agent.sendMessage(WORKSPACE, { content: "hello" });

    expect(sentWhileRunning).toBe(false);
    expect(delivered).toBe("hello");
  });
});
