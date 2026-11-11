import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
import { eq } from "drizzle-orm";
import { fakeProducer, managedFixture } from "./managed-fixture.test";
import { createSessionRecovery, type PlacementLauncher } from "./recovery";

async function placedSession(m: Awaited<ReturnType<typeof managedFixture>>) {
  const sessionId = randomUUID();
  await m.f.store.managed.sessions.create(m.keyId, { sessionId, profileId: m.profileId, profileRevision: 1 });
  await m.submit(sessionId, "complete");
  return sessionId;
}

test("a shared session joins compute with room, and closing one session leaves its siblings running", async () => {
  const producer = fakeProducer();
  const m = await managedFixture(producer.server.port);
  const launched: Awaited<ReturnType<typeof m.launch>>[] = [];
  const stopped: string[] = [];
  const launcher: PlacementLauncher = {
    async create(_principal, body) {
      const next = await m.launch();
      launched.push(next);
      // The workspace service stores the metadata naming the session that placement launched it for.
      await m.f.context.db
        .update(m.f.context.tables.workspaces)
        .set({ metadata: body.metadata ?? {} })
        .where(eq(m.f.context.tables.workspaces.id, next.id));
      return (await m.f.store.getWorkspace(next.id)) as WorkspaceRow;
    },
    stop: async (_principal, id) => {
      stopped.push(id);
    },
  };
  const recovery = createSessionRecovery({ store: m.f.store, launcher });
  try {
    const first = await placedSession(m);
    await recovery.tick(); // launches and records the first placement
    const second = await placedSession(m);
    // Binds the first while the second joins its workspace, then binds the second and observes both ready.
    for (let i = 0; i < 3; i++) await recovery.tick();
    expect(launched).toHaveLength(1);
    const workspaceId = launched[0]?.id;
    for (const sessionId of [first, second])
      expect((await m.f.store.managed.sessions.get(m.keyId, sessionId)).state).toBe("ready");
    const usage = await m.f.store.managed.budgets.usage(m.keyId, m.scopeId);
    expect(usage.activeWorkspaces).toBe(1);

    await m.f.store.managed.sessions.close(m.keyId, first, { cancelId: randomUUID() }, 30000, new Date());
    for (let i = 0; i < 3; i++) await recovery.tick();
    expect(stopped).toEqual([]);
    expect((await m.f.store.managed.sessions.get(m.keyId, second)).state).toBe("ready");
    expect(workspaceId).toBeDefined();
  } finally {
    for (const next of launched) await next.dispose();
    await m.f.dispose();
    await producer.server.stop(true);
  }
});

test("a shared session launches new compute once the joined workspace is at its process limit", async () => {
  const producer = fakeProducer();
  const m = await managedFixture(producer.server.port);
  const launched: Awaited<ReturnType<typeof m.launch>>[] = [];
  const launcher: PlacementLauncher = {
    async create() {
      const next = await m.launch();
      launched.push(next);
      return (await m.f.store.getWorkspace(next.id)) as WorkspaceRow;
    },
    stop: async () => {},
  };
  const recovery = createSessionRecovery({ store: m.f.store, launcher });
  try {
    const { effectiveAt: _, ...policy } = await m.f.store.managed.budgets.readPolicy(m.keyId, m.scopeId);
    await m.f.store.managed.budgets.writePolicy(
      m.keyId,
      { ...policy, revision: policy.revision + 1, limits: { ...policy.limits, maxChatProcessesPerWorkspace: 1 } },
      policy.revision,
    );
    await placedSession(m);
    await recovery.tick();
    await placedSession(m);
    await recovery.tick();
    expect(launched).toHaveLength(2);
  } finally {
    for (const next of launched) await next.dispose();
    await m.f.dispose();
    await producer.server.stop(true);
  }
});
