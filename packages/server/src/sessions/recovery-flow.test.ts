import { expect, test } from "bun:test";
import type { PrincipalRow, WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
import { eq } from "drizzle-orm";
import { fakeProducer, managedFixture } from "./managed-fixture.test";
import { createSessionRecovery, type PlacementLauncher } from "./recovery";

async function terminate(store: Awaited<ReturnType<typeof managedFixture>>["f"]["store"], id: string) {
  await store.transition(id, { from: ["ready", "connected"], to: "terminating", at: new Date() });
  await store.transition(id, { from: ["terminating"], to: "canceled", at: new Date() });
  await store.managed.capacity.cleanup(id, 0, "provider_fenced", new Date());
  // The scheduler records this after its driver removed the workspace's input projections.
  await store.managed.requests.completeCleanup(id);
}

test("replacing lost compute keeps the session, never re-dispatches started work and resumes unstarted work", async () => {
  const producer = fakeProducer();
  const m = await managedFixture(producer.server.port);
  const launched: Awaited<ReturnType<typeof m.launch>>[] = [];
  const created: string[] = [];
  // The fixture driver stands in for the scheduler launch; everything else is the production owner.
  const launcher: PlacementLauncher = {
    async create(_principal: PrincipalRow, body, key, workspaceId) {
      created.push(key);
      expect(body.metadata?.["pocketcoder.managed-session"]).toBeDefined();
      const next = launched[0] ?? (await m.launch(workspaceId));
      launched[0] = next;
      return (await m.f.store.getWorkspace(next.id)) as WorkspaceRow;
    },
    stop: async (_principal, id) => terminate(m.f.store, id),
  };
  try {
    const sessionId = await m.session();
    const started = await m.submit(sessionId, "run started");
    await m.settle();
    const waiting = await m.submit(sessionId, "run waiting");
    expect((await m.request(sessionId, started)).state).toBe("running");

    await m.f.store.endWorkspaceRuntime(m.f.id, m.f.runtime.incarnationId, new Date());
    expect(await m.request(sessionId, started)).toMatchObject({ state: "terminal", outcome: "lost" });

    const recovery = createSessionRecovery({ store: m.f.store, launcher });
    await recovery.tick(); // fences the old writer
    await recovery.tick(); // detaches the ended binding
    expect((await m.f.store.managed.sessions.get(m.keyId, sessionId)).state).toBe("suspended");
    await recovery.tick(); // records a placement and its capacity
    // A restarted controller continues from the recorded placement instead of launching again.
    const restarted = createSessionRecovery({ store: m.f.store, launcher });
    await restarted.tick(); // binds generation 2
    await restarted.tick(); // observes it ready
    expect(created).toEqual([`managed-session:${sessionId}:2`]);
    const session = await m.f.store.managed.sessions.get(m.keyId, sessionId);
    expect(session).toMatchObject({ sessionId, state: "ready" });

    const replacement = launched[0];
    if (!replacement) throw Error("Missing replacement");
    for (let i = 0; i < 3; i++) {
      await replacement.dispatcher.tick();
      await replacement.dispatcher.drain();
    }
    expect((await m.request(sessionId, waiting)).state).toBe("running");
    expect(producer.sent("run started")).toHaveLength(1);
    expect(producer.sent("run waiting")).toHaveLength(1);
    const physical = producer.journal.find((entry) => entry.message === "run waiting");
    expect(physical?.requestId).toBe((await m.request(sessionId, waiting)).turnId);
    // The stale generation cannot bind again.
    await expect(
      m.f.store.managed.sessions.bind({ principalId: m.f.principal.id, sessionId }, 99, {
        workspaceId: m.f.id,
        incarnationId: m.f.runtime.incarnationId,
        generation: 1,
      }),
    ).rejects.toMatchObject({ code: "revision.stale" });
    const history = await m.f.store.managed.history.history(m.keyId, sessionId, null, 50);
    expect(history.records.map((record) => record.status)).toEqual(["lost"]);
    await replacement.dispose();
  } finally {
    await m.f.dispose();
    await producer.server.stop(true);
  }
});

test("resume is idempotent, placement waits for capacity and a closed session is never placed", async () => {
  const producer = fakeProducer();
  const m = await managedFixture(producer.server.port);
  const created: string[] = [];
  const launcher: PlacementLauncher = {
    async create(_principal, _body, key) {
      created.push(key);
      throw new Error("not expected");
    },
    stop: async () => {},
  };
  try {
    const sessionId = (
      await m.f.store.managed.sessions.create(m.keyId, {
        sessionId: crypto.randomUUID(),
        profile: m.profileId,
        owner: "test-owner",
      })
    ).sessionId;
    const first = await m.f.store.managed.recovery.resume(m.keyId, sessionId, new Date());
    const again = await m.f.store.managed.recovery.resume(m.keyId, sessionId, new Date());
    expect(again.revision).toBe(first.revision);
    await m.f.store.managed.sessions.close(m.keyId, sessionId, new Date());
    await createSessionRecovery({ store: m.f.store, launcher }).tick();
    expect(created).toEqual([]);
    await expect(m.f.store.managed.recovery.resume(m.keyId, sessionId, new Date())).rejects.toMatchObject({
      code: "session.closed",
    });
  } finally {
    await m.f.dispose();
    await producer.server.stop(true);
  }
});

// The workspace service stamps this metadata on compute the placement owner creates.
async function placed(m: Awaited<ReturnType<typeof managedFixture>>, sessionId: string, workspaceId?: string) {
  const next = await m.launch(workspaceId);
  await m.f.context.db
    .update(m.f.context.tables.workspaces)
    .set({ metadata: { "pocketcoder.managed-session": sessionId } })
    .where(eq(m.f.context.tables.workspaces.id, next.id));
  return next;
}

test("a close during placement stops the placed workspace and completes only after it ended", async () => {
  const producer = fakeProducer();
  const m = await managedFixture(producer.server.port);
  const launched: Awaited<ReturnType<typeof m.launch>>[] = [];
  const sessionId = crypto.randomUUID();
  const launcher: PlacementLauncher = {
    async create(_principal, _body, _key, workspaceId) {
      const next = await placed(m, sessionId, workspaceId);
      launched.push(next);
      return (await m.f.store.getWorkspace(next.id)) as WorkspaceRow;
    },
    stop: async (_principal, id) => terminate(m.f.store, id),
  };
  try {
    await m.f.store.managed.sessions.create(m.keyId, { sessionId, profile: m.profileId, owner: "test-owner" });
    await m.submit(sessionId, "run queued");
    const recovery = createSessionRecovery({ store: m.f.store, launcher });
    await recovery.tick(); // creates and records the placement, before any binding
    const workspace = launched[0];
    if (!workspace) throw Error("Missing placement");
    const close = await m.f.store.managed.sessions.close(m.keyId, sessionId, new Date());
    expect(close.receipt.state).toBe("pending");
    await recovery.tick(); // stops the placed workspace
    await m.f.store.managed.requests.prepare(new Date());
    const replay = await m.f.store.managed.sessions.close(m.keyId, sessionId, new Date());
    expect(replay.receipt.state).toBe("completed");
    expect((await m.f.store.getWorkspace(workspace.id))?.terminalAt).not.toBeNull();
    await workspace.dispose();
  } finally {
    await m.f.dispose();
    await producer.server.stop(true);
  }
});

test("a failed placement consumes its generation, waits for resume and then launches new compute", async () => {
  const producer = fakeProducer();
  const m = await managedFixture(producer.server.port);
  const keys: string[] = [];
  const sessionId = crypto.randomUUID();
  const launched: Awaited<ReturnType<typeof m.launch>>[] = [];
  const launcher: PlacementLauncher = {
    async create(_principal, _body, key, workspaceId) {
      keys.push(key);
      const next = await placed(m, sessionId, workspaceId);
      launched.push(next);
      // The first launch ends before it was ready.
      if (keys.length === 1) await terminate(m.f.store, next.id);
      return (await m.f.store.getWorkspace(next.id)) as WorkspaceRow;
    },
    stop: async (_principal, id) => terminate(m.f.store, id),
  };
  try {
    await m.f.store.managed.sessions.create(m.keyId, { sessionId, profile: m.profileId, owner: "test-owner" });
    await m.f.store.managed.recovery.resume(m.keyId, sessionId, new Date());
    const recovery = createSessionRecovery({ store: m.f.store, launcher });
    await recovery.tick(); // places the first workspace
    await recovery.tick(); // sees it ended
    expect(await m.f.store.managed.sessions.get(m.keyId, sessionId)).toMatchObject({
      state: "failed",
      reasonCode: "placement_failed",
    });
    const revision = (await m.f.store.managed.sessions.get(m.keyId, sessionId)).revision;
    await recovery.tick();
    await recovery.tick();
    // No retry loop without a new resume.
    expect(keys).toHaveLength(1);
    expect((await m.f.store.managed.sessions.get(m.keyId, sessionId)).revision).toBe(revision);
    await m.f.store.managed.recovery.resume(m.keyId, sessionId, new Date());
    await recovery.tick(); // places a new workspace under the next generation
    await recovery.tick(); // binds it
    expect(keys).toEqual([`managed-session:${sessionId}:1`, `managed-session:${sessionId}:2`]);
    expect((await m.f.store.managed.sessions.get(m.keyId, sessionId)).state).not.toBe("failed");
    for (const next of launched) await next.dispose();
  } finally {
    await m.f.dispose();
    await producer.server.stop(true);
  }
});

test("ended compute from an older release detaches before queued work is placed", async () => {
  const producer = fakeProducer();
  const m = await managedFixture(producer.server.port);
  try {
    const sessionId = await m.session();
    await m.submit(sessionId, "queued for the current release");
    await terminate(m.f.store, m.f.id);
    await m.f.context.db
      .update(m.f.context.tables.workspaces)
      .set({ templateDigest: `sha256:${"0".repeat(64)}` })
      .where(eq(m.f.context.tables.workspaces.id, m.f.id));
    await createSessionRecovery({
      store: m.f.store,
      launcher: {
        create: async () => {
          throw Error("not expected");
        },
        stop: async () => {
          throw Error("not expected");
        },
      },
    }).tick();
    expect(await m.f.store.managed.sessions.binding(m.keyId, sessionId)).toBeNull();
  } finally {
    await m.f.dispose();
    await producer.server.stop(true);
  }
});
