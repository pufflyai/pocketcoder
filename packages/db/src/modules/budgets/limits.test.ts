import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { bindCompute, managedFixture, policy, provision } from "../managed/fixture.test";
import { createManagedBudgets } from "./budgets";

test("overlapping scope and model bounds commit no partial charge and never shrink a response to fit", async () => {
  const f = await managedFixture();
  try {
    await provision(f);
    const workspaceId = await bindCompute(f);
    const second = randomUUID();
    await f.store.managed.authority.registerScope(f.keyId, second, f.principal.id);
    await f.store.managed.budgets.writePolicy(
      f.keyId,
      {
        ...policy(second),
        modelLimits: [
          {
            model: "fixture/model",
            inputTokens: 10,
            outputTokens: 25,
          },
        ],
      },
      null,
    );
    const profile = { ...f.profile, revision: 2, budgetScopeIds: [f.scopeId, second] };
    await f.store.managed.authority.provisionProfile(f.keyId, f.principal.id, profile);
    const sessionId = randomUUID();
    await f.store.managed.sessions.create(f.keyId, { sessionId, profileId: profile.profileId, profileRevision: 2 });
    // A second logical session uses separate compute because its profile revision differs.
    const { insertTestWorkspace } = await import("../../test-fixtures");
    const w = await insertTestWorkspace(f, randomUUID());
    const { eq } = await import("drizzle-orm");
    const incarnationId = randomUUID();
    await f.context.db
      .update(f.context.tables.workspaces)
      .set({
        state: "ready",
        runtimeRegistration: { incarnationId, containerIdentity: incarnationId, profile: "service", producer: null },
      })
      .where(eq(f.context.tables.workspaces.id, w.id));
    await f.store.managed.sessions.bind({ principalId: f.principal.id, sessionId }, 0, {
      workspaceId: w.id,
      incarnationId,
      generation: 1,
    });
    const base = {
      identity: { principalId: f.principal.id, sessionId, requestId: randomUUID(), invocationId: randomUUID() },
      workspaceId: w.id,
      requestDigest: `sha256:${"a".repeat(64)}`,
      countEvidenceRef: "local-count/1",
      model: "fixture/model",
      inputTokens: 11,
      requestedOutputTokens: 20,
    };
    await expect(f.store.managed.budgets.reserve(base)).rejects.toThrow();
    expect((await f.store.managed.budgets.usage(f.keyId, f.scopeId)).heldInputTokens).toBe(0);
    const first = { ...base, inputTokens: 5 };
    await f.store.managed.budgets.reserve(first);
    await expect(f.store.managed.budgets.reserve({ ...first, inputTokens: 6 })).rejects.toThrow();
    await expect(
      f.store.managed.budgets.reserve({
        ...first,
        identity: { ...first.identity, invocationId: randomUUID() },
        inputTokens: 1,
        requestedOutputTokens: null,
      }),
    ).rejects.toThrow();
    expect((await f.store.managed.budgets.usage(f.keyId, second)).heldOutputTokens).toBe(20);
    await expect(
      f.store.managed.budgets.writePolicy(f.keyId, { ...policy(second, 2), period: "utc_month" }, 1),
    ).rejects.toThrow();
    expect(workspaceId).toBeString();
  } finally {
    await f.dispose();
  }
});

test("output defaults, explicit clamping, rolling rates and in-flight slots survive backward clocks", async () => {
  const f = await managedFixture();
  try {
    await provision(f);
    const workspaceId = await bindCompute(f);
    const p = policy(f.scopeId, 2);
    p.limits.inputTokens = null;
    p.limits.outputTokens = null;
    p.limits.modelRequestsPerMinute = 1;
    await f.store.managed.budgets.writePolicy(f.keyId, p, 1);
    let at = new Date(Date.now() + 1000);
    const budgets = createManagedBudgets(f.context, () => at);
    const base = {
      identity: {
        principalId: f.principal.id,
        sessionId: f.sessionId,
        requestId: randomUUID(),
        invocationId: randomUUID(),
      },
      workspaceId,
      requestDigest: `sha256:${"a".repeat(64)}`,
      countEvidenceRef: "local-count/1",
      model: "fixture/model",
      inputTokens: 1,
      requestedOutputTokens: 100,
    };
    expect((await budgets.reserve(base)).reservation.outputTokenCap).toBe(40);
    await budgets.abandonUnsent(base.identity);
    at = new Date(at.getTime() - 10_000);
    await expect(
      budgets.reserve({ ...base, identity: { ...base.identity, invocationId: randomUUID() } }),
    ).rejects.toThrow();
    at = new Date(Date.now() + 62_000);
    const next = { ...base, identity: { ...base.identity, invocationId: randomUUID() }, requestedOutputTokens: null };
    // Extend the test fixture's physical lifetime, without altering a production budget.
    const { eq } = await import("drizzle-orm");
    await f.context.db
      .update(f.context.tables.workspaces)
      .set({ deadlineAt: new Date(at.getTime() + 60_000) })
      .where(eq(f.context.tables.workspaces.id, workspaceId));
    expect((await budgets.reserve(next)).reservation.outputTokenCap).toBe(20);
  } finally {
    await f.dispose();
  }
});
