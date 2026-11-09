import { randomUUID } from "node:crypto";
import { ApiError } from "@pstdio/pocketcoder-contracts";
import { insertTestWorkspace, managedFixture, provisionManaged } from "@pstdio/pocketcoder-db/testing";
import { eq } from "drizzle-orm";
import type { ModelGatewayConfig } from "./config";
import { createModelGateway } from "./gateway";
import type { GatewayGrant, ManagedRequestIdentity } from "./grant";
import { providerFixture } from "./provider-fixture.test";

export const PROVIDER_KEY = "sk-fixture-provider-secret";
export const WORKSPACE_BEARER = "pcw-fixture-workspace-grant";

// A real store with one session bound to ready compute, a real provider over HTTP and the gateway
// served over HTTP, so client disconnects and dropped streams behave as they do in production.
export async function gatewayFixture(usage = { inputTokens: 40, outputTokens: 10 }) {
  const f = await managedFixture();
  await provisionManaged(f);
  const workspace = await insertTestWorkspace(f, randomUUID());
  const incarnationId = randomUUID();
  await f.context.db
    .update(f.context.tables.workspaces)
    .set({
      state: "ready",
      runtimeRegistration: { incarnationId, containerIdentity: incarnationId, profile: "service", producer: null },
    })
    .where(eq(f.context.tables.workspaces.id, workspace.id));
  await f.store.managed.sessions.bind({ principalId: f.principal.id, sessionId: f.sessionId }, 0, {
    workspaceId: workspace.id,
    incarnationId,
    generation: 1,
  });
  const provider = providerFixture(usage);
  const config: ModelGatewayConfig = {
    provider: "openai",
    upstreamUrl: provider.url,
    providerAccountId: "fixture-account",
    apiKey: PROVIDER_KEY,
    models: { "fixture/model": { providerModel: "provider-model-1", minOutputTokens: 5 } },
    maxRequestBytes: 65_536,
    maxConcurrentCalls: 8,
    drainTimeoutMs: 5_000,
  };
  const grant: GatewayGrant = {
    identity: { principalId: f.principal.id, sessionId: f.sessionId, requestId: randomUUID() },
    workspaceId: workspace.id,
    incarnationId,
    generation: 1,
    allowedModels: f.profile.allowedModels,
  };
  const denied: ManagedRequestIdentity[] = [];
  const errors: unknown[] = [];
  const handler = createModelGateway({
    budgets: f.store.managed.budgets,
    config,
    resolveGrant: async (bearer) => {
      if (bearer !== WORKSPACE_BEARER) throw new ApiError("auth.invalid_key", "Unknown gateway credential.");
      return grant;
    },
    onBudgetDenied: async (identity) => {
      denied.push(identity);
    },
    onError: (error) => errors.push(error),
  });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler, idleTimeout: 30 });
  const call = (body: Record<string, unknown>, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${WORKSPACE_BEARER}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      ...init,
    });
  const invocations = async () =>
    (await f.context.db.select().from(f.context.tables.budgetInvocations)).map((row) => row.record);
  return {
    f,
    provider,
    grant,
    config,
    denied,
    errors,
    call,
    invocations,
    usage: () => f.store.managed.budgets.usage(f.keyId, f.scopeId),
    async dispose() {
      await server.stop(true);
      await provider.stop();
      await f.dispose();
    },
  };
}

export const textRequest = (extra: Record<string, unknown> = {}) => ({
  model: "fixture/model",
  input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
  instructions: "Answer briefly.",
  tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }],
  ...extra,
});
