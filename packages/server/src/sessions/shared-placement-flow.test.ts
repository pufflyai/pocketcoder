import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
import { eq } from "drizzle-orm";
import { fakeProducer, managedFixture } from "./managed-fixture.test";
import { createSessionRecovery, type PlacementLauncher } from "./recovery";

// The production placement owner over fixture compute: launches are real fixture workspaces,
// stops are only recorded, and credential delivery is recorded (it is tested on its own).
async function sharedPlacement(run: (p: Awaited<ReturnType<typeof placementFixture>>) => Promise<void>) {
  const producer = fakeProducer();
  const p = await placementFixture(producer.server.port);
  try {
    await run(p);
  } finally {
    for (const next of p.launched) await next.dispose();
    await p.m.f.dispose();
    await producer.server.stop(true);
  }
}

async function placementFixture(port: number | undefined) {
  const m = await managedFixture(port);
  const launched: Awaited<ReturnType<typeof m.launch>>[] = [];
  const stopped: string[] = [];
  const credentials: string[] = [];
  // Whether the workspace has confirmed the session's credentials, as the credential owner reports it.
  const installed = { value: true };
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
  const recovery = createSessionRecovery({
    store: m.f.store,
    launcher,
    credentials: {
      deliver: async (identity) => {
        credentials.push(`deliver:${identity.sessionId}`);
        return installed.value;
      },
      revoke: async (_workspaceId, sessionId) => {
        credentials.push(`revoke:${sessionId}`);
      },
    },
  });
  async function placedSession() {
    const sessionId = randomUUID();
    await m.f.store.managed.sessions.create(m.keyId, { sessionId, profileId: m.profileId, profileRevision: 1 });
    await m.submit(sessionId, "complete");
    return sessionId;
  }
  const ticks = async (count: number) => {
    for (let i = 0; i < count; i++) await recovery.tick();
  };
  const close = (sessionId: string) =>
    m.f.store.managed.sessions.close(m.keyId, sessionId, { cancelId: randomUUID() }, 30000, new Date());
  const state = async (sessionId: string) => (await m.f.store.managed.sessions.get(m.keyId, sessionId)).state;
  return { m, launched, stopped, credentials, installed, placedSession, ticks, close, state };
}

test("a shared session joins compute with room, and closing one session leaves its siblings running", async () => {
  await sharedPlacement(async (p) => {
    const first = await p.placedSession();
    await p.ticks(1); // launches and records the first placement
    const second = await p.placedSession();
    // Binds the first while the second joins its workspace, then binds the second and observes both ready.
    await p.ticks(3);
    expect(p.launched).toHaveLength(1);
    for (const sessionId of [first, second]) expect(await p.state(sessionId)).toBe("ready");
    expect((await p.m.f.store.managed.budgets.usage(p.m.keyId, p.m.scopeId)).activeWorkspaces).toBe(1);
    expect(new Set(p.credentials)).toEqual(new Set([`deliver:${first}`, `deliver:${second}`]));

    await p.close(first);
    await p.ticks(3);
    expect(p.stopped).toEqual([]);
    expect(p.credentials).toContain(`revoke:${first}`);
    expect(p.credentials).not.toContain(`revoke:${second}`);
    expect(await p.state(second)).toBe("ready");

    await p.close(second);
    await p.ticks(3);
    expect(new Set(p.stopped)).toEqual(new Set(p.launched.map((next) => next.id)));
  });
});

test("a session closed before it binds never keeps shared compute alive", async () => {
  await sharedPlacement(async (p) => {
    const first = await p.placedSession();
    await p.ticks(3);
    const joiner = await p.placedSession();
    await p.ticks(1); // the joiner holds a process slot but has not bound yet
    await p.close(joiner);
    await p.ticks(3);
    await p.close(first);
    await p.ticks(4);
    expect(new Set(p.stopped)).toEqual(new Set(p.launched.map((next) => next.id)));
  });
});

test("a shared session launches new compute once the joined workspace is at its process limit", async () => {
  await sharedPlacement(async (p) => {
    const { effectiveAt: _, ...policy } = await p.m.f.store.managed.budgets.readPolicy(p.m.keyId, p.m.scopeId);
    await p.m.f.store.managed.budgets.writePolicy(
      p.m.keyId,
      { ...policy, revision: policy.revision + 1, limits: { ...policy.limits, maxChatProcessesPerWorkspace: 1 } },
      policy.revision,
    );
    await p.placedSession();
    await p.ticks(1);
    await p.placedSession();
    await p.ticks(1);
    expect(p.launched).toHaveLength(2);
  });
});

test("a session never joins compute whose producer cannot run conversations side by side", async () => {
  await sharedPlacement(async (p) => {
    await p.placedSession();
    await p.ticks(3);
    const workspace = await p.m.f.store.getWorkspace(p.launched[0]?.id ?? "");
    const registration = structuredClone(workspace?.runtimeRegistration);
    if (!workspace || !registration?.producer) throw new Error("Missing installed producer");
    registration.producer.capabilities = registration.producer.capabilities.filter(
      (capability) => capability !== "parallel-conversations",
    );
    await p.m.f.context.db
      .update(p.m.f.context.tables.workspaces)
      .set({ runtimeRegistration: registration })
      .where(eq(p.m.f.context.tables.workspaces.id, workspace.id));
    const second = await p.placedSession();
    await p.ticks(4);
    expect(p.launched).toHaveLength(2);
    expect(await p.state(second)).toBe("ready");
  });
});

test("a session becomes ready only once its workspace confirmed its credentials", async () => {
  await sharedPlacement(async (p) => {
    p.installed.value = false;
    const sessionId = await p.placedSession();
    await p.ticks(4);
    expect(await p.state(sessionId)).toBe("provisioning");
    p.installed.value = true;
    await p.ticks(1);
    expect(await p.state(sessionId)).toBe("ready");
  });
});
