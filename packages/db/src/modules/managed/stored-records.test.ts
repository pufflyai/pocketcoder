import { expect, test } from "bun:test";
import { managedFixture, policy, provision } from "./fixture.test";

test("profiles and policies stored with model usage fields still read, replay and place", async () => {
  const f = await managedFixture();
  try {
    await provision(f);
    const { managedProfiles: profiles, budgetPolicies: policies } = f.context.tables;
    // Rows written before model usage moved to the gateway.
    await f.context.db.update(profiles).set({ profile: { ...f.profile, allowedModels: ["old/model"] } as never });
    const stored = policy(f.scopeId);
    await f.context.db.update(policies).set({
      policy: {
        ...stored,
        effectiveAt: new Date().toISOString(),
        limits: { ...stored.limits, inputTokens: 100, defaultOutputTokens: 20 },
        modelLimits: [],
      } as never,
    });
    expect(await f.store.managed.authority.profile(f.keyId, f.profile.profileId, 1)).toEqual(f.profile);
    expect(await f.store.managed.authority.provisionProfile(f.keyId, f.principal.id, f.profile)).toEqual(f.profile);
    expect((await f.store.managed.budgets.readPolicy(f.keyId, f.scopeId)).limits).toEqual(stored.limits);
    expect((await f.store.managed.budgets.writePolicy(f.keyId, stored, null)).revision).toBe(1);
    expect((await f.store.managed.sessions.get(f.keyId, f.sessionId)).sessionId).toBe(f.sessionId);
  } finally {
    await f.dispose();
  }
});
