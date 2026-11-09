import { expect, test } from "bun:test";
import { managedFixture, policy } from "../managed/fixture.test";

test("concurrent policy creation, lost replies and stale changes retain one immutable revision", async () => {
  const f = await managedFixture();
  try {
    await f.store.managed.authority.registerScope(f.keyId, f.scopeId, f.principal.id, true);
    const input = policy(f.scopeId);
    const [a, b] = await Promise.all([
      f.store.managed.budgets.writePolicy(f.keyId, input, null),
      f.store.managed.budgets.writePolicy(f.keyId, input, null),
    ]);
    expect(a).toEqual(b);
    expect(a.effectiveAt).toBeString();
    await expect(
      f.store.managed.budgets.writePolicy(f.keyId, { ...input, period: "utc_month" }, null),
    ).rejects.toThrow();
    const next = { ...input, revision: 2, limits: { ...input.limits, workspaceStarts: 0 } };
    expect((await f.store.managed.budgets.writePolicy(f.keyId, next, 1)).revision).toBe(2);
    await expect(f.store.managed.budgets.writePolicy(f.keyId, { ...next, revision: 3 }, 1)).rejects.toThrow();
  } finally {
    await f.dispose();
  }
});
