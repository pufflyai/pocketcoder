import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { fakeProducer, managedFixture } from "../sessions/managed-fixture.test";
import { createModelGateway } from "./gateway";
import { GATEWAY_TURN_HEADER } from "./grant";
import { providerFixture } from "./provider-fixture.test";

const PROVIDER_KEY = "sk-grant-flow-provider-secret";

test("gateway credentials bind one workspace incarnation and resolve only its unfinished turns", async () => {
  const producer = fakeProducer();
  const m = await managedFixture(producer.server.port);
  const provider = providerFixture({ inputTokens: 30, outputTokens: 8 });
  const other = await m.launch();
  try {
    const grants = m.f.store.managed.grants;
    const [a, b] = [await m.session(), await m.session()];
    const ra = await m.submit(a, "run a");
    const rb = await m.submit(b, "run b");
    await m.settle();
    const turnA = (await m.request(a, ra)).turnId;
    const turnB = (await m.request(b, rb)).turnId;
    const first = await grants.issue(m.f.id, m.f.runtime.incarnationId, new Date());
    const token = (await grants.issue(m.f.id, m.f.runtime.incarnationId, new Date())).token;
    expect(first.expiresAt <= ((await m.f.store.getWorkspace(m.f.id))?.deadlineAt ?? new Date(0))).toBe(true);
    const resolve = (bearer: string, turn: string | null) => grants.resolve(bearer, turn, new Date());

    // Re-issue after a lost delivery leaves exactly one valid credential.
    await expect(resolve(first.token, turnA)).rejects.toMatchObject({ code: "auth.invalid_key" });
    expect(await resolve(token, turnA)).toMatchObject({
      identity: { principalId: m.f.principal.id, sessionId: a, requestId: ra },
      workspaceId: m.f.id,
      generation: 1,
      allowedModels: ["fixture/model"],
    });
    // Credential-free siblings on one workspace share its trust boundary.
    expect((await resolve(token, turnB)).identity.sessionId).toBe(b);
    await expect(resolve(token, null)).rejects.toMatchObject({ code: "auth.invalid_key" });
    await expect(resolve(token, randomUUID())).rejects.toMatchObject({ code: "auth.invalid_key" });
    // Another workspace's credential cannot select this workspace's turn.
    const foreign = await grants.issue(other.id, other.runtime.incarnationId, new Date());
    await expect(resolve(foreign.token, turnA)).rejects.toMatchObject({ code: "auth.invalid_key" });

    // The real gateway reserves, sends once and settles under the resolved identity.
    const gateway = createModelGateway({
      budgets: m.f.store.managed.budgets,
      resolveGrant: (bearer, turn) => resolve(bearer, turn),
      config: {
        provider: "openai",
        upstreamUrl: provider.url,
        providerAccountId: "fixture-account",
        apiKey: PROVIDER_KEY,
        models: { "fixture/model": { providerModel: "provider-model-1", minOutputTokens: 5 } },
        maxRequestBytes: 65536,
        maxConcurrentCalls: 4,
        drainTimeoutMs: 2000,
      },
    });
    const call = (bearer: string, turn: string) =>
      gateway(
        new Request("http://controller/v1/model-gateway/v1/responses", {
          method: "POST",
          headers: {
            authorization: `Bearer ${bearer}`,
            [GATEWAY_TURN_HEADER]: turn,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "fixture/model",
            input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
            max_output_tokens: 20,
          }),
        }),
      );
    const ok = await call(token, turnA);
    expect(ok.status).toBe(200);
    expect(await ok.text()).not.toContain(PROVIDER_KEY);
    expect((await m.f.store.managed.budgets.usage(m.keyId, m.scopeId)).settledInputTokens).toBe(30);
    expect((await call(foreign.token, turnA)).status).toBe(401);

    // A request with a pending stop cannot start new model calls.
    const c = await m.session();
    const rc = await m.submit(c, "run c");
    await m.settle();
    const turnC = (await m.request(c, rc)).turnId;
    expect((await resolve(token, turnC)).identity.sessionId).toBe(c);
    await m.f.store.managed.requests.cancel(m.keyId, c, rc, { cancelId: randomUUID() }, 30000, new Date());
    await expect(resolve(token, turnC)).rejects.toMatchObject({ code: "auth.invalid_key" });

    // Closing one session ends its authority without fencing its sibling.
    await m.f.store.managed.sessions.close(m.keyId, a, { cancelId: randomUUID() }, 30000, new Date());
    await expect(resolve(token, turnA)).rejects.toMatchObject({ code: "auth.invalid_key" });
    expect((await resolve(token, turnB)).identity.sessionId).toBe(b);

    // Ending the incarnation ends every credential for it.
    await m.f.store.endWorkspaceRuntime(m.f.id, m.f.runtime.incarnationId, new Date());
    await expect(resolve(token, turnB)).rejects.toMatchObject({ code: "auth.invalid_key" });

    // Only digests are stored; the token never reaches events or history.
    const stored = JSON.stringify(await m.f.context.db.select().from(m.f.context.tables.modelGatewayGrants));
    const events = JSON.stringify(await m.f.context.db.select().from(m.f.context.tables.managedObservations));
    for (const text of [stored, events]) {
      expect(text).not.toContain(token);
      expect(text).not.toContain(PROVIDER_KEY);
    }
    expect(provider.journal.every((entry) => !JSON.stringify(entry).includes(token))).toBe(true);
  } finally {
    await other.dispose();
    await m.f.dispose();
    await provider.stop();
    await producer.server.stop(true);
  }
});
