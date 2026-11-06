import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { managedFixture, policy } from "./fixture.test";

test("profiles are immutable, require installation scope and recheck caller grants", async () => {
  const f = await managedFixture();
  try {
    await f.store.managed.authority.registerScope(f.keyId, f.scopeId, f.principal.id, true);
    const profile = await f.store.managed.authority.provisionProfile(f.keyId, f.principal.id, f.profile);
    expect(profile).toEqual(f.profile);
    expect(await f.store.managed.authority.provisionProfile(f.keyId, f.principal.id, f.profile)).toEqual(profile);
    await expect(
      f.store.managed.authority.provisionProfile(f.keyId, f.principal.id, { ...f.profile, allowedModels: ["other"] }),
    ).rejects.toThrow();
    await expect(
      f.store.managed.authority.provisionProfile(f.keyId, f.principal.id, {
        ...f.profile,
        profileId: randomUUID(),
        budgetScopeIds: [randomUUID()],
      }),
    ).rejects.toThrow();
    await f.store.revokeMachineKey(f.keyId, new Date());
    await expect(f.store.managed.authority.profile(f.keyId, f.profile.profileId, 1)).rejects.toThrow();
  } finally {
    await f.dispose();
  }
});

test("execution grantees may revise only their personal budget policies", async () => {
  const f = await managedFixture();
  try {
    const restrictedKey = randomUUID();
    await f.store.insertMachineKey({
      id: restrictedKey,
      principalId: f.principal.id,
      secretDigest: new Uint8Array([2]),
      scopes: ["budgets:admin", "budgets:read"],
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 600_000),
      revokedAt: null,
      lastUsedAt: null,
    });
    await f.store.managed.authority.registerScope(f.keyId, f.scopeId, f.principal.id, true);
    await expect(f.store.managed.budgets.writePolicy(restrictedKey, policy(f.scopeId), null)).rejects.toThrow();
    await f.store.managed.budgets.writePolicy(f.keyId, policy(f.scopeId), null);
    expect((await f.store.managed.budgets.readPolicy(restrictedKey, f.scopeId)).revision).toBe(1);
    const personal = randomUUID();
    await f.store.managed.authority.registerScope(f.keyId, personal, f.principal.id);
    await f.store.managed.budgets.writePolicy(restrictedKey, policy(personal), null);
    const other = await f.store.createPrincipal("other execution grantee", ["budgets:read"], ["*"]);
    await f.store.managed.authority.registerScope(f.keyId, personal, other.id);
    await expect(f.store.managed.budgets.writePolicy(restrictedKey, policy(personal, 2), 1)).rejects.toThrow();
    expect((await f.store.managed.budgets.writePolicy(f.keyId, policy(personal, 2), 1)).revision).toBe(2);
  } finally {
    await f.dispose();
  }
});
