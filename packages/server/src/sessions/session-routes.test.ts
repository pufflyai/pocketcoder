import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { managed } from "@pstdio/pocketcoder-contracts";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { authed, createTestServer } from "../testing/test-server.test";

const createStore = createTestStoreFactory();
test("public provisioning and session/policy routes enforce ownership, preconditions and bounded authority", async () => {
  const store = await createStore();
  const server = await createTestServer(store);
  const caller = await store.getMachineKeyWithPrincipal(server.keyId);
  if (!caller) throw Error("Missing caller");
  await store.updatePrincipal(caller.principal.id, ["admin"], ["*"]);
  const scopeId = randomUUID(),
    profileId = randomUUID(),
    sessionId = randomUUID();
  const request = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) =>
    server.app.request(
      path,
      authed(server.token, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), headers }),
    );
  expect(
    (
      await request(`/v1/budget-scopes/${scopeId}/grant`, "PUT", {
        principalId: caller.principal.id,
        installation: true,
      })
    ).status,
  ).toBe(204);
  const template = (await store.listTemplates(null))[0];
  if (!template) throw Error("Missing template");
  const profile = {
    profileId,
    revision: 1,
    isolationScopeId: randomUUID(),
    budgetScopeIds: [scopeId],
    templateDigest: template.digest,
    allowedModels: ["local/model"],
    credentialBindingId: null,
  };
  expect(
    (
      await request(
        `/v1/execution-profiles/${profileId}/revisions/1?principalId=${caller.principal.id}`,
        "PUT",
        profile,
      )
    ).status,
  ).toBe(200);
  const input = { sessionId, profileId, profileRevision: 1 };
  const created = await request("/v1/sessions", "POST", input);
  expect(created.status).toBe(200);
  const first = managed.SessionSchema.parse(await created.json());
  expect(first.state).toBe("provisioning");
  expect(await (await request("/v1/sessions", "POST", input)).json()).toEqual(first);
  expect((await request("/v1/sessions", "POST", { ...input, profileRevision: 2 })).status).toBe(409);
  expect((await request(`/v1/sessions/${sessionId}`)).status).toBe(200);
  const policy = {
    scopeId,
    revision: 1,
    period: "utc_day",
    limits: {
      inputTokens: null,
      outputTokens: 0,
      workspaceStarts: 0,
      maxActiveWorkspaces: 0,
      maxInFlightModelRequests: 0,
      modelRequestsPerMinute: 0,
      modelRequestsPerMinutePerWorkspace: 0,
      maxRunningRequestsPerSession: 1,
      maxChatProcessesPerWorkspace: 1,
      defaultOutputTokens: 1,
      maxOutputTokensPerInvocation: 2,
    },
    modelLimits: [],
  };
  const path = `/v1/budget-scopes/${scopeId}/policy`;
  expect((await request(path, "PUT", policy)).status).toBe(412);
  const written = await request(path, "PUT", policy, { "if-none-match": "*" });
  expect(written.status).toBe(200);
  expect(written.headers.get("etag")).toBe('"1"');
  expect((await request(path, "PUT", policy, { "if-none-match": "*" })).status).toBe(200);
  expect((await request(path, "PUT", { ...policy, revision: 2 }, { "if-match": '"2"' })).status).toBe(412);
  expect((await request(`/v1/budget-scopes/${scopeId}/usage`)).status).toBe(200);
  await store.updatePrincipal(caller.principal.id, ["sessions:read", "sessions:write", "budgets:read"], ["*"]);
  expect((await request(path, "PUT", policy, { "if-none-match": "*" })).status).toBe(403);
  expect((await request(`/v1/budget-scopes/${randomUUID()}/policy`)).status).toBe(404);
  expect((await request(`/v1/sessions/${randomUUID()}`)).status).toBe(404);
  expect((await request(`/v1/budget-scopes/${scopeId}/settle`, "POST", { outputTokens: 0 })).status).toBe(404);
});
