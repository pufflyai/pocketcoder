import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessContext, HarnessEventSink } from "@pstdio/sdk/extensions";
import { createMemoryStorage, makeCommandContext } from "@pstdio/sdk/testing";
import { createMachineHarness } from "./agent";
import { reconnectFileTurn, startFileTurn, supportsFileTurns } from "./file-turns";
import { createInstances } from "./instances";

async function fixture(handle: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, fetch: handle });
  const root = await mkdtemp(join(tmpdir(), "pc-file-turn-"));
  const instanceId = randomUUID(),
    machineId = randomUUID(),
    sessionId = randomUUID();
  const directory = join(root, instanceId);
  await mkdir(directory);
  await Bun.write(join(directory, "instance.json"), JSON.stringify({ id: instanceId, url: server.url.toString() }));
  await Bun.write(
    join(directory, "owner.json"),
    JSON.stringify({ token: "host-fixture", expiresAt: new Date(Date.now() + 60000).toISOString() }),
  );
  const state = createMemoryStorage();
  const ctx: HarnessContext = {
    ...makeCommandContext({
      storage: createMemoryStorage(),
      projectId: "test",
      params: {},
      overrides: { extensionId: "pocketcoder.pocketcoder" },
    }),
    name: "fixture",
    logger: console,
    state: {
      get: (key) => state.get(key),
      set: (key, value) => state.set(key, value),
      delete: (key) => state.delete(key),
    },
  };
  const instances = createInstances(root);
  const ref = { instanceId, machineId, sessionId: `${instanceId}:${machineId}`, instances };
  const events: HarnessEventSink = { getMessages: () => [], push() {} };
  const input = { sessionId, prompt: "hello", events, signal: AbortSignal.timeout(5000) };
  return {
    ctx,
    ref,
    input,
    state,
    async close() {
      await server.stop(true);
      await rm(root, { recursive: true, force: true });
    },
  };
}

test.each([400, 413, 422])("a definitive initial POST rejection (%s) releases the pending turn", async (status) => {
  let rejected = true;
  let request: { requestId: string; content: string };
  const f = await fixture(async (req) => {
    if (req.method === "POST") {
      if (rejected) return Response.json({ error: "invalid input" }, { status });
      request = await req.json();
      return Response.json({});
    }
    const receipt = {
      acceptance: {
        execution: { requestId: request.requestId },
        input: { content: request.content },
        inputs: { objects: [] },
      },
      phase: "terminal",
      finalizedAt: new Date().toISOString(),
      outcome: { content: "reply" },
    };
    return Response.json(
      new URL(req.url).searchParams.has("limit") ? { items: [receipt], next_cursor: null } : receipt,
    );
  });
  try {
    const first = await startFileTurn(f.ctx, f.input, f.ref);
    expect(await first.done).toEqual({ status: "failed" });
    expect(await f.state.get(`file-turn:${f.input.sessionId}`)).toBeUndefined();
    rejected = false;
    const next = await startFileTurn(f.ctx, f.input, f.ref);
    expect(await next.done).toEqual({ status: "completed" });
  } finally {
    await f.close();
  }
});

test("a rejected replay retains a request whose first submission may have succeeded", async () => {
  let attempts = 0;
  const f = await fixture(() =>
    Response.json({ error: "uncertain first submission" }, { status: ++attempts === 1 ? 503 : 422 }),
  );
  try {
    const first = await startFileTurn(f.ctx, f.input, f.ref);
    expect(await first.done).toEqual({ status: "disconnected" });
    const pending = await f.state.get(`file-turn:${f.input.sessionId}`);
    expect(pending).toBeDefined();
    const replay = await reconnectFileTurn(f.ctx, { ...f.input, agentSessionId: first.agentSessionId ?? "" }, f.ref);
    expect(await replay?.done).toEqual({ status: "disconnected" });
    expect(await f.state.get<unknown>(`file-turn:${f.input.sessionId}`)).toEqual(pending);
    await expect(startFileTurn(f.ctx, f.input, f.ref)).rejects.toThrow("pending request");
  } finally {
    await f.close();
  }
});

test("a denied optional capability route retains text turns and terminal history", async () => {
  let terminal = false;
  const messages: { role: string; content: string }[] = [];
  const f = await fixture(async (req) => {
    const path = new URL(req.url).pathname;
    if (path.endsWith("/capabilities"))
      return Response.json(
        { error: { code: "relay.route_not_allowed", message: "Route not allowed" } },
        { status: 422 },
      );
    if (path.endsWith("/message")) {
      const body = await req.json();
      messages.push({ role: "user", content: body.content }, { role: "agent", content: "text reply" });
      return Response.json({});
    }
    if (path.endsWith("/messages")) return Response.json({ messages });
    if (path.endsWith("/status")) return Response.json({ status: "stable" });
    if (path.endsWith("/conversation"))
      return Response.json({
        items: [
          {
            message_id: "retained",
            role: "assistant",
            content: "retained reply",
            occurred_at: new Date().toISOString(),
          },
        ],
        next_cursor: null,
      });
    return Response.json({ state: terminal ? "canceled" : "ready", agent_state: "stable" });
  });
  try {
    expect(await supportsFileTurns(f.ref)).toEqual({ requests: false, attachments: false });
    const harness = createMachineHarness(() => f.ref.instances);
    const workspace = {
      workspaceId: randomUUID(),
      executionTarget: {
        kind: "remote" as const,
        providerId: "pocketcoder.pocketcoder.workspace-type.machine",
        providerRef: { version: 1 as const, data: { instanceId: f.ref.instanceId, machineId: f.ref.machineId } },
      },
    };
    const session = await harness.start(f.ctx, { ...f.input, workspace });
    expect(await session.done).toEqual({ status: "completed" });
    terminal = true;
    expect(
      JSON.stringify(await harness.getMessages(f.ctx, { workspace, agentSessionId: session.agentSessionId ?? "" })),
    ).toContain("retained reply");
  } finally {
    await f.close();
  }
});

test("capability detection preserves authorization failures", async () => {
  const f = await fixture(() => new Response(null, { status: 403 }));
  try {
    await expect(supportsFileTurns(f.ref)).rejects.toThrow("403");
  } finally {
    await f.close();
  }
});
