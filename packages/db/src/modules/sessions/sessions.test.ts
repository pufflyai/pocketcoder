import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { DatabaseStore } from "../../store";
import { managedFixture, provision } from "../managed/fixture.test";

test("no-compute sessions replay after restart and fence old binding revisions", async () => {
  const f = await managedFixture("disk");
  let store = f.store;
  try {
    const session = await provision(f);
    expect(session.state).toBe("provisioning");
    await store.close();
    store = await DatabaseStore.openPGlite(f.directory);
    const input = { sessionId: f.sessionId, profileId: f.profile.profileId, profileRevision: 1 };
    expect(await store.managed.sessions.create(f.keyId, input)).toEqual(session);
    await expect(store.managed.sessions.create(f.keyId, { ...input, profileRevision: 2 })).rejects.toThrow();
    const id = { principalId: f.principal.id, sessionId: f.sessionId };
    const binding = { workspaceId: randomUUID(), incarnationId: randomUUID(), generation: 1 };
    // Binding requires actual owned compute, never a caller-provided UUID alone.
    await expect(store.managed.sessions.bind(id, 0, binding)).rejects.toThrow();
    expect((await store.managed.sessions.get(f.keyId, f.sessionId)).sessionId).toBe(f.sessionId);
  } finally {
    if (store !== f.store) await store.close();
    await f.dispose();
  }
});

test("session observations enforce the public transitions and allow failed sessions to close", async () => {
  const f = await managedFixture();
  try {
    const initial = await provision(f);
    const id = { principalId: f.principal.id, sessionId: f.sessionId };
    const suspended = await f.store.managed.sessions.appendObservation(id, initial.revision, "suspended", null);
    await expect(f.store.managed.sessions.appendObservation(id, suspended.revision, "ready", null)).rejects.toThrow();
    expect(await f.store.managed.sessions.get(f.keyId, f.sessionId)).toEqual(suspended);
    const failed = await f.store.managed.sessions.appendObservation(id, suspended.revision, "failed", "provider_lost");
    expect((await f.store.managed.sessions.appendObservation(id, failed.revision, "closed", null)).state).toBe(
      "closed",
    );
  } finally {
    await f.dispose();
  }
});

test("failed sessions can bind fresh compute after the previous binding is fenced", async () => {
  const f = await managedFixture();
  try {
    await provision(f);
    const id = { principalId: f.principal.id, sessionId: f.sessionId };
    const current = await f.store.managed.sessions.get(f.keyId, f.sessionId);
    await f.store.managed.sessions.appendObservation(id, current.revision, "failed", "provider_lost");
    const { bindCompute } = await import("../managed/fixture.test");
    await bindCompute(f);
    expect((await f.store.managed.sessions.get(f.keyId, f.sessionId)).state).toBe("provisioning");
  } finally {
    await f.dispose();
  }
});

test("binding comparisons retain generation history after detach and observations roll back with their transaction", async () => {
  const f = await managedFixture();
  try {
    await provision(f);
    const { bindCompute } = await import("../managed/fixture.test");
    const workspaceId = await bindCompute(f);
    const identity = { principalId: f.principal.id, sessionId: f.sessionId };
    await expect(f.store.managed.sessions.bind(identity, 0, null)).rejects.toThrow();
    await expect(f.store.managed.sessions.bind(identity, 1, null)).rejects.toThrow();
    const before = await f.store.managed.sessions.get(f.keyId, f.sessionId);
    const { sessionWriter } = await import("./observations");
    await expect(
      f.context.db.transaction(async (tx) => {
        await sessionWriter(f.context).update(tx, identity, before.revision, "suspended", null);
        throw Error("rollback cut");
      }),
    ).rejects.toThrow("rollback cut");
    expect(await f.store.managed.sessions.get(f.keyId, f.sessionId)).toEqual(before);
    await f.store.transition(workspaceId, { from: ["ready"], to: "terminating", at: new Date() });
    await f.store.transition(workspaceId, { from: ["terminating"], to: "canceled", at: new Date() });
    expect(await f.store.managed.sessions.bind(identity, 1, null)).toBe(2);
    const { insertTestWorkspace } = await import("../../test-fixtures");
    const successor = await insertTestWorkspace(f, randomUUID());
    const incarnationId = randomUUID();
    const { eq } = await import("drizzle-orm");
    await f.context.db
      .update(f.context.tables.workspaces)
      .set({
        state: "provisioning",
        runtimeRegistration: { incarnationId, containerIdentity: incarnationId, profile: "service", producer: null },
      })
      .where(eq(f.context.tables.workspaces.id, successor.id));
    await expect(
      f.store.managed.sessions.bind(identity, 2, { workspaceId: successor.id, incarnationId, generation: 1 }),
    ).rejects.toThrow();
    expect(
      await f.store.managed.sessions.bind(identity, 2, { workspaceId: successor.id, incarnationId, generation: 2 }),
    ).toBe(3);
    const current = await f.store.managed.sessions.get(f.keyId, f.sessionId);
    await f.store.managed.sessions.appendObservation(identity, current.revision, "closed", null);
    expect(
      (
        await f.store.managed.sessions.create(f.keyId, {
          sessionId: f.sessionId,
          profileId: f.profile.profileId,
          profileRevision: 1,
        })
      ).state,
    ).toBe("closed");
  } finally {
    await f.dispose();
  }
});
