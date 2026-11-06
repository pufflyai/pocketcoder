import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { managedFixture } from "./fixture.test";

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
