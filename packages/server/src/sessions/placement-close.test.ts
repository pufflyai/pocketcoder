import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { WorkspaceService } from "../workspaces/service";
import { fakeProducer, managedFixture } from "./managed-fixture.test";
import { createSessionRecovery } from "./recovery";

test("close before workspace insertion leaves no queued placement after completion", async () => {
  const producer = fakeProducer();
  const m = await managedFixture(producer.server.port);
  const sessionId = randomUUID();
  const key = `managed-session:${sessionId}:1`;
  const errors: unknown[] = [];
  const service = new WorkspaceService({ store: m.f.store, scheduler: m.f.scheduler, limits: DEFAULT_LIMITS });
  try {
    await m.f.store.managed.sessions.create(m.keyId, { sessionId, profileId: m.profileId, profileRevision: 1 });
    await m.submit(sessionId, "run queued");
    const recovery = createSessionRecovery({
      store: m.f.store,
      onError: (error) => errors.push(error),
      launcher: {
        async create(principal, body, idempotencyKey) {
          const close = await m.f.store.managed.sessions.close(
            m.keyId,
            sessionId,
            { cancelId: randomUUID() },
            30000,
            new Date(),
          );
          expect(close.receipt.state).toBe("completed");
          return (await service.create(principal, body, idempotencyKey)).workspace;
        },
        stop: async (principal, id) => {
          await service.cancel(principal, id);
        },
      },
    });
    await recovery.tick();
    await recovery.tick();
    expect(await m.f.store.getWorkspaceByIdempotency(m.f.principal.id, key)).toBeNull();
    expect(errors).toMatchObject([{ code: "session.closed" }]);
    expect(await m.f.store.managed.recovery.candidates()).toEqual([]);
  } finally {
    await m.f.dispose();
    await producer.server.stop(true);
  }
});

test("workspace insertion before close keeps close pending until queued placement is stopped", async () => {
  const producer = fakeProducer();
  const m = await managedFixture(producer.server.port);
  const sessionId = randomUUID();
  const cancelId = randomUUID();
  const key = `managed-session:${sessionId}:1`;
  const service = new WorkspaceService({ store: m.f.store, scheduler: m.f.scheduler, limits: DEFAULT_LIMITS });
  try {
    await m.f.store.managed.sessions.create(m.keyId, { sessionId, profileId: m.profileId, profileRevision: 1 });
    await m.submit(sessionId, "run queued");
    const recovery = createSessionRecovery({
      store: m.f.store,
      launcher: {
        async create(principal, body, idempotencyKey) {
          const { workspace } = await service.create(principal, body, idempotencyKey);
          const close = await m.f.store.managed.sessions.close(m.keyId, sessionId, { cancelId }, 30000, new Date());
          expect(close.receipt.state).toBe("pending");
          return workspace;
        },
        stop: async (principal, id) => {
          await service.cancel(principal, id);
        },
      },
    });
    await recovery.tick();
    await recovery.tick();
    await m.f.store.managed.requests.prepare(new Date());
    const workspace = await m.f.store.getWorkspaceByIdempotency(m.f.principal.id, key);
    expect(workspace?.state).toBe("canceled");
    expect(workspace?.terminalAt).not.toBeNull();
    const closed = await m.f.store.managed.sessions.close(m.keyId, sessionId, { cancelId }, 30000, new Date());
    expect(closed.receipt.state).toBe("completed");
  } finally {
    await m.f.dispose();
    await producer.server.stop(true);
  }
});
