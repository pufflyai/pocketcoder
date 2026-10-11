import { describe, expect, test } from "bun:test";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { parseTemplateManifest } from "@pstdio/pocketcoder-contracts";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { authed, createTestServer, SERVER_TEST_PEPPER, type TestServer } from "../testing/test-server.test";
import { fakeAgent, type RelayFrame, readyWorkspace, respondJson } from "./relay-fixtures.test";

const createStore = createTestStoreFactory();

// Replaces the default fixture with a native AgentAPI agent.
async function useAgentTemplate(server: TestServer, agent: Record<string, unknown>) {
  const parsed = parseTemplateManifest({
    apiVersion: "pocketcoder.dev/v1alpha1",
    kind: "Template",
    metadata: { name: "fixture-echo" },
    spec: {
      version: "2.0.0",
      image: `example.test/agent@sha256:${"a".repeat(64)}`,
      agent,
      resources: { cpu: "1", memory: "512Mi" },
    },
  });
  await server.store.upsertTemplate({
    name: "fixture-echo",
    version: "2.0.0",
    digest: parsed.digest,
    description: null,
    spec: parsed.manifest.spec,
  });
}

function agentWithStatus(server: TestServer, id: string, status: "running" | "stable") {
  return fakeAgent(server, id, (frame) => {
    respondJson(server, id, frame, frame.payload.path === "/status" ? { status } : { ok: true });
  });
}

function relayed(sent: string[]) {
  return sent
    .map((data) => JSON.parse(data) as RelayFrame & { type: string })
    .filter((frame) => frame.type === "proxy_request")
    .map(({ payload }) => ({
      method: payload.method,
      path: payload.path,
      body: payload.body_b64 ? JSON.parse(Buffer.from(payload.body_b64, "base64").toString()) : undefined,
    }));
}

function interrupt(server: TestServer, id: string, token = server.token) {
  return server.app.request(`/v1/workspaces/${id}/agent/interrupt`, authed(token, { method: "POST" }));
}

describe("agent turn interrupt", () => {
  test("sends the template's interrupt keys while a turn runs", async () => {
    const server = await createTestServer(await createStore());
    await useAgentTemplate(server, { command: ["/usr/local/bin/run-pi"], interruptKeys: "\u001b" });
    const id = await readyWorkspace(server);
    const { sent } = agentWithStatus(server, id, "running");

    const res = await interrupt(server, id);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "requested" });
    expect(relayed(sent)).toEqual([
      { method: "GET", path: "/status", body: undefined },
      { method: "POST", path: "/message", body: { type: "raw", content: "\u001b" } },
    ]);
    expect((await server.store.getWorkspace(id))?.state).toBe("ready");
  });

  test("sends nothing while the agent waits for input", async () => {
    const server = await createTestServer(await createStore());
    await useAgentTemplate(server, { command: ["/usr/local/bin/run-pi"], interruptKeys: "\u001b" });
    const id = await readyWorkspace(server);
    const { sent } = agentWithStatus(server, id, "stable");
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit) =>
      server.app.request(input, init)) as typeof fetch;
    const client = new PocketCoderClient({ baseUrl: "http://pocketcoder.test", apiKey: server.token }, fetchImpl);

    expect(await client.agent.interrupt(id)).toEqual({ status: "idle" });
    expect(relayed(sent)).toEqual([{ method: "GET", path: "/status", body: undefined }]);
  });

  test("rejects agents without interrupt keys and leaves the workspace running", async () => {
    for (const agent of [undefined, { command: ["/usr/local/bin/run-pi"] }]) {
      const server = await createTestServer(await createStore());
      if (agent) await useAgentTemplate(server, agent);
      const id = await readyWorkspace(server);
      const { sent } = agentWithStatus(server, id, "running");

      const res = await interrupt(server, id);

      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("agent.interrupt_unsupported");
      expect(relayed(sent)).toEqual([]);
      expect((await server.store.getWorkspace(id))?.state).toBe("ready");
    }
  });

  test("requires the relay scope and workspace ownership", async () => {
    const server = await createTestServer(await createStore());
    await useAgentTemplate(server, { command: ["/usr/local/bin/run-pi"], interruptKeys: "\u001b" });
    const id = await readyWorkspace(server);
    const { sent } = agentWithStatus(server, id, "running");
    const other = await server.store.createPrincipal("other-backend", ["services:relay"], ["*"]);
    const otherKey = issueMachineKey(SERVER_TEST_PEPPER);
    await server.store.insertMachineKey({
      id: otherKey.id,
      principalId: other.id,
      secretDigest: otherKey.secretDigest,
      scopes: [],
      createdAt: new Date(),
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
    });

    expect((await interrupt(server, id, server.limitedToken)).status).toBe(403);
    expect((await interrupt(server, id, otherKey.token)).status).toBe(404);
    expect(relayed(sent)).toEqual([]);
  });
});
