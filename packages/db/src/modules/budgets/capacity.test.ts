import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { DatabaseStore } from "../../store";
import { insertTestWorkspace } from "../../test-fixtures";
import { managedFixture, policy, provision } from "../managed/fixture.test";

test("managed physical capacity is charged once, retains uncertain cleanup and fences stale release", async () => {
  const f = await managedFixture();
  try {
    await provision(f);
    const limit = policy(f.scopeId, 2);
    limit.limits.maxActiveWorkspaces = 1;
    await f.store.managed.budgets.writePolicy(f.keyId, limit, 1);
    const a = await insertTestWorkspace(f, randomUUID());
    const b = await insertTestWorkspace(f, randomUUID());
    const identity = { principalId: f.principal.id, sessionId: f.sessionId, workspaceId: a.id, generation: 1 };
    await f.store.managed.capacity.place(identity);
    await f.store.managed.capacity.place(identity);
    expect((await f.store.managed.budgets.usage(f.keyId, f.scopeId)).activeWorkspaces).toBe(1);
    await expect(f.store.managed.capacity.place({ ...identity, workspaceId: b.id })).rejects.toThrow();
    await f.store.claimWorkspaceAdmission({
      workspaceId: a.id,
      at: new Date(),
      registrationDigest: new Uint8Array([1]),
      registrationExpiresAt: new Date(Date.now() + 60000),
      limits: DEFAULT_LIMITS,
    });
    await f.store.managed.capacity.claimLaunch(a.id, 1, new Date());
    await f.store.managed.capacity.claimLaunch(a.id, 1, new Date());
    expect((await f.store.managed.budgets.usage(f.keyId, f.scopeId)).workspaceStarts).toBe(1);
    await expect(f.store.managed.capacity.cleanup(a.id, 0, "provider_fenced", new Date())).rejects.toThrow();
    expect((await f.store.managed.budgets.usage(f.keyId, f.scopeId)).activeWorkspaces).toBe(1);
    const proof = await f.store.managed.capacity.cleanup(a.id, 1, "provider_fenced", new Date());
    expect(await f.store.managed.capacity.cleanup(a.id, 1, "provider_fenced", new Date())).toEqual(proof);
    expect((await f.store.managed.budgets.usage(f.keyId, f.scopeId)).activeWorkspaces).toBe(0);
    expect((await f.store.managed.budgets.usage(f.keyId, f.scopeId)).workspaceStarts).toBe(1);
  } finally {
    await f.dispose();
  }
});

test("restart after admission before provider send cleans up the admitted generation and its start hold", async () => {
  const f = await managedFixture("disk");
  let store = f.store;
  try {
    await provision(f);
    const budget = policy(f.scopeId, 2);
    budget.limits.workspaceStarts = 1;
    await store.managed.budgets.writePolicy(f.keyId, budget, 1);
    const workspace = await insertTestWorkspace(f, randomUUID());
    await store.managed.capacity.place({
      principalId: f.principal.id,
      sessionId: f.sessionId,
      workspaceId: workspace.id,
      generation: 1,
    });
    const claim = {
      workspaceId: workspace.id,
      at: new Date(),
      registrationDigest: new Uint8Array([1]),
      registrationExpiresAt: new Date(Date.now() + 60000),
      limits: DEFAULT_LIMITS,
    };
    expect(await store.claimWorkspaceAdmission(claim)).not.toBeNull();
    await store.close();
    store = await DatabaseStore.openPGlite(f.directory);
    await store.managed.capacity.cleanupPending(workspace.id, 1, new Date());
    expect((await store.managed.budgets.usage(f.keyId, f.scopeId)).activeWorkspaces).toBe(1);
    await store.managed.capacity.cleanup(workspace.id, 1, "never_launched", new Date());
    expect(await store.managed.budgets.usage(f.keyId, f.scopeId)).toMatchObject({
      activeWorkspaces: 0,
      workspaceStarts: 0,
    });
    await store.transition(workspace.id, { from: ["provisioning"], to: "queued", at: new Date() });
    expect(await store.claimWorkspaceAdmission({ ...claim, at: new Date() })).not.toBeNull();
  } finally {
    if (store !== f.store) await store.close();
    await f.dispose();
  }
});
