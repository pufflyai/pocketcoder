import { expect, test } from "bun:test";
import { managed } from "@pstdio/pocketcoder-contracts";
import type { WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
import { eq, sql } from "drizzle-orm";
import { fakeProducer, managedFixture } from "./managed-fixture.test";
import { createSessionRecovery, type PlacementLauncher } from "./recovery";

for (const mode of ["missing", "poisoned", "retired"])
  test(`unavailable templates suspend safely and corrected profiles resume after restart (${mode})`, async () => {
    const producer = fakeProducer();
    const m = await managedFixture(producer.server.port);
    let launched: Awaited<ReturnType<typeof m.launch>> | undefined;
    let creates = 0;
    const errors: unknown[] = [];
    const launcher: PlacementLauncher = {
      async create(_principal, _body, _key, workspaceId) {
        creates++;
        launched = await m.launch(workspaceId);
        return (await m.f.store.getWorkspace(launched.id)) as WorkspaceRow;
      },
      async stop() {},
    };
    try {
      const sessionId = crypto.randomUUID();
      await m.f.store.managed.sessions.create(m.keyId, { sessionId, profile: m.profileId, owner: "test-owner" });
      const requestId = await m.submit(sessionId, "complete after profile repair");
      const configure = (version: string) =>
        m.f.store.managed.profiles.reconcile(
          m.f.principal.id,
          {
            [m.profileId]: managed.ProfileConfigSchema.parse({
              template: m.f.runtime.template.name,
              templateVersion: version,
              placement: "shared",
            }),
          },
          {},
        );
      let oldWorkspace: string | undefined;
      if (mode === "poisoned") {
        const intent = await m.f.store.managed.capacity.reserve(
          { principalId: m.f.principal.id, sessionId },
          1,
          new Date(),
        );
        if (!intent) throw new Error("Missing placement");
        oldWorkspace = intent.workspaceId;
        const { managedSessions, managedCapacity } = m.f.store.context.tables;
        // Reproduce the persisted intent written by the old missing-template path.
        await m.f.store.context.db
          .update(managedSessions)
          .set({ placement: sql`${JSON.stringify({ ...intent, templateDigest: "", templateVersion: null })}::jsonb` })
          .where(eq(managedSessions.sessionId, sessionId));
        const [capacity] = await m.f.store.context.db
          .select()
          .from(managedCapacity)
          .where(eq(managedCapacity.workspaceId, oldWorkspace));
        if (!capacity) throw new Error("Missing capacity");
        await m.f.store.context.db
          .update(managedCapacity)
          .set({ record: { ...capacity.record, templateDigest: "", templateVersion: null } })
          .where(eq(managedCapacity.workspaceId, oldWorkspace));
      }
      if (mode === "retired") {
        const intent = await m.f.store.managed.capacity.reserve(
          { principalId: m.f.principal.id, sessionId },
          1,
          new Date(),
        );
        if (!intent) throw new Error("Missing placement");
        oldWorkspace = intent.workspaceId;
        await m.f.store.retireTemplate(m.keyId, m.f.runtime.template.name, m.f.runtime.template.version);
      }
      await configure("9.9.9");
      const recovery = createSessionRecovery({ store: m.f.store, launcher, onError: (error) => errors.push(error) });
      await recovery.tick();
      const waiting = await m.f.store.managed.sessions.get(m.keyId, sessionId);
      expect(waiting).toMatchObject({ state: "suspended", reasonCode: "template_unavailable" });
      await recovery.tick();
      expect(await m.f.store.managed.sessions.get(m.keyId, sessionId)).toEqual(waiting);
      expect((await m.request(sessionId, requestId)).state).toBe("accepted");
      expect(creates).toBe(0);
      expect(errors).toEqual([]);
      if (mode === "retired") {
        const rows = await m.f.store.context.db.select().from(m.f.store.context.tables.managedCapacity);
        expect(rows.find((r) => r.workspaceId === oldWorkspace)?.record.state).toBe("released");
        return;
      }
      await configure(m.f.runtime.template.version);
      const restarted = createSessionRecovery({ store: m.f.store, launcher });
      for (let i = 0; i < 3; i++) await restarted.tick();
      expect(creates).toBe(1);
      if (oldWorkspace) {
        const rows = await m.f.store.context.db.select().from(m.f.store.context.tables.managedCapacity);
        expect(rows.find((r) => r.workspaceId === oldWorkspace)?.record).toMatchObject({
          state: "released",
          cleanup: { basis: "never_launched" },
        });
        expect(rows.filter((r) => r.record.state !== "released")).toHaveLength(1);
        expect(await m.f.store.managed.sessions.binding(m.keyId, sessionId)).toMatchObject({ generation: 2 });
      }
      expect(await m.f.store.managed.sessions.get(m.keyId, sessionId)).toMatchObject({
        state: "ready",
        reasonCode: null,
      });
      if (!launched) throw new Error("Missing recovered workspace");
      for (let i = 0; i < 3; i++) {
        await launched.dispatcher.tick();
        await launched.dispatcher.drain();
      }
      expect(await m.request(sessionId, requestId)).toMatchObject({ state: "terminal", outcome: "completed" });
    } finally {
      await launched?.dispose();
      await m.f.dispose();
      await producer.server.stop(true);
    }
  });

test("a valid saved placement continues when the current profile pin becomes missing", async () => {
  const producer = fakeProducer();
  const m = await managedFixture(producer.server.port);
  let launched: Awaited<ReturnType<typeof m.launch>> | undefined;
  try {
    const sessionId = crypto.randomUUID();
    const identity = { principalId: m.f.principal.id, sessionId };
    await m.f.store.managed.sessions.create(m.keyId, { sessionId, profile: m.profileId, owner: "test-owner" });
    await m.submit(sessionId, "complete using the reserved template");
    const intent = await m.f.store.managed.capacity.reserve(identity, 1, new Date());
    if (!intent) throw new Error("Missing placement");
    await m.f.store.managed.profiles.reconcile(
      m.f.principal.id,
      {
        [m.profileId]: managed.ProfileConfigSchema.parse({
          template: m.f.runtime.template.name,
          templateVersion: "9.9.9",
        }),
      },
      {},
    );
    const errors: unknown[] = [];
    const recovery = createSessionRecovery({
      store: m.f.store,
      onError: (error) => errors.push(error),
      launcher: {
        async create(_principal, _body, _key, workspaceId) {
          launched = await m.launch(workspaceId);
          return (await m.f.store.getWorkspace(launched.id)) as WorkspaceRow;
        },
        async stop() {},
      },
    });
    for (let i = 0; i < 3; i++) await recovery.tick();
    expect(errors).toEqual([]);
    expect(await m.f.store.managed.sessions.get(m.keyId, sessionId)).toMatchObject({
      state: "ready",
      reasonCode: null,
    });
    expect(await m.f.store.managed.sessions.binding(m.keyId, sessionId)).toMatchObject({
      workspaceId: intent.workspaceId,
      generation: 1,
    });
  } finally {
    await launched?.dispose();
    await m.f.dispose();
    await producer.server.stop(true);
  }
});
