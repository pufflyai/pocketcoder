import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { sessionWorkFixture } from "./work-fixture.test";

const limits = { count: 3, bytes: 1048576 };
const input = (requestId = randomUUID()) => ({
  requestId,
  message: "run tests",
  attachments: [],
});

test("runtime fencing after terminal persistence preserves the observed outcome and waits for cleanup proof", async () => {
  const f = await sessionWorkFixture();
  try {
    await f.store.managed.sessions.bind({ principalId: f.principal.id, sessionId: f.sessionId }, 0, {
      workspaceId: f.id,
      incarnationId: f.runtime.incarnationId,
      generation: 1,
    });
    const body = input();
    await f.store.managed.requests.accept(f.keyId, f.sessionId, body, limits);
    await f.store.managed.requests.prepare(new Date());
    const record = (await f.store.executions.pending())[0];
    if (!record) throw Error("Missing execution");
    await f.store.executions.claim(record.acceptance.execution, new Date());
    await f.store.executions.observe(
      record.acceptance.execution,
      record.acceptance.fingerprint,
      "terminal",
      1,
      new Date(),
      { status: "completed", finalResponse: "retained" },
    );
    await f.store.endWorkspaceRuntime(f.id, f.runtime.incarnationId, new Date());
    expect(await f.store.managed.requests.get(f.keyId, f.sessionId, body.requestId)).toMatchObject({
      state: "terminal",
      outcome: "completed",
      finalResponse: "retained",
      collection: { state: "settled", completeness: "complete", cleanupState: "pending" },
    });
    expect((await f.store.executions.get(record.acceptance.execution))?.acknowledgedAt).toBeNull();
    expect(await f.store.executions.pending()).toHaveLength(0);
    await f.store.managed.requests.completeCleanup(f.id);
    expect((await f.store.managed.requests.get(f.keyId, f.sessionId, body.requestId)).collection.cleanupState).toBe(
      "complete",
    );
  } finally {
    await f.dispose();
  }
});

test("shared sessions namespace physical IDs and hold only their own serial finalization barrier", async () => {
  const f = await sessionWorkFixture();
  try {
    const second = randomUUID();
    await f.store.managed.sessions.create(f.keyId, { sessionId: second, profile: f.profile.name, owner: "test-owner" });
    for (const sessionId of [f.sessionId, second])
      await f.store.managed.sessions.bind({ principalId: f.principal.id, sessionId }, 0, {
        workspaceId: f.id,
        incarnationId: f.runtime.incarnationId,
        generation: 1,
      });
    const body = input();
    const a = await f.store.managed.requests.accept(f.keyId, f.sessionId, body, limits);
    await f.store.managed.requests.accept(f.keyId, second, body, limits);
    const later = await f.store.managed.requests.accept(f.keyId, f.sessionId, input(), limits);
    await f.store.managed.requests.prepare(new Date());
    const pending = await f.store.executions.pending();
    expect(pending).toHaveLength(2);
    expect(new Set(pending.map((row) => row.acceptance.execution.requestId)).size).toBe(2);
    const first = pending.find((row) => row.acceptance.execution.requestId === a.request.turnId)!;
    expect(await f.store.executions.get(first.acceptance.execution)).toEqual(first);
    await f.store.executions.claim(first.acceptance.execution, new Date());
    await f.store.executions.observe(
      first.acceptance.execution,
      first.acceptance.fingerprint,
      "terminal",
      1,
      new Date(),
      { status: "completed" },
    );
    await f.store.exports.seal(first.acceptance.execution, new Date());
    await f.store.managed.requests.prepare(new Date());
    expect((await f.store.managed.requests.get(f.keyId, f.sessionId, later.request.requestId)).state).toBe("accepted");
    await f.store.executions.acknowledge(first.acceptance.execution, first.acceptance.fingerprint, new Date());
    await f.store.executions.finalize(first.acceptance.execution, new Date());
    await f.store.managed.requests.prepare(new Date());
    expect((await f.store.managed.requests.get(f.keyId, f.sessionId, later.request.requestId)).state).toBe("waiting");
  } finally {
    await f.dispose();
  }
});

test("a materialized or proved-absent request cannot send after its dispatch deadline", async () => {
  const f = await sessionWorkFixture();
  try {
    await f.store.managed.sessions.bind({ principalId: f.principal.id, sessionId: f.sessionId }, 0, {
      workspaceId: f.id,
      incarnationId: f.runtime.incarnationId,
      generation: 1,
    });
    const body = input();
    await f.store.managed.requests.accept(f.keyId, f.sessionId, body, limits);
    await f.store.managed.requests.prepare(new Date());
    const record = (await f.store.executions.pending())[0]!;
    await f.store.executions.claim(record.acceptance.execution, new Date());
    expect(await f.store.executions.beforeSend(record.acceptance.execution, new Date())).toBe(true);
    expect(
      await f.store.executions.beforeSend(
        record.acceptance.execution,
        new Date(
          Date.parse((await f.store.managed.requests.get(f.keyId, f.sessionId, body.requestId)).dispatchDeadline) + 1,
        ),
      ),
    ).toBe(false);
    const request = await f.store.managed.requests.get(f.keyId, f.sessionId, body.requestId);
    expect(request).toMatchObject({
      state: "terminal",
      outcome: "failed",
      startedAt: null,
      collection: { completeness: "lost" },
    });
    expect((await f.context.db.select().from(f.context.tables.managedSessions))[0]?.queueCount).toBe(0);
  } finally {
    await f.dispose();
  }
});

test("one revoked accepting key cannot stop another session, and fenced runtime loss settles its queue", async () => {
  const f = await sessionWorkFixture();
  try {
    const keyId = randomUUID(),
      second = randomUUID();
    await f.store.insertMachineKey({
      id: keyId,
      principalId: f.principal.id,
      secretDigest: new Uint8Array([3]),
      scopes: ["sessions:read", "sessions:write"],
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60000),
      revokedAt: null,
      lastUsedAt: null,
    });
    await f.store.managed.sessions.create(f.keyId, { sessionId: second, profile: f.profile.name, owner: "test-owner" });
    for (const sessionId of [f.sessionId, second])
      await f.store.managed.sessions.bind({ principalId: f.principal.id, sessionId }, 0, {
        workspaceId: f.id,
        incarnationId: f.runtime.incarnationId,
        generation: 1,
      });
    await f.store.managed.requests.accept(keyId, f.sessionId, input(), limits);
    const good = await f.store.managed.requests.accept(f.keyId, second, input(), limits);
    await f.store.revokeMachineKey(keyId, new Date());
    await f.store.managed.requests.prepare(new Date());
    expect((await f.store.managed.requests.get(f.keyId, second, good.request.requestId)).state).toBe("waiting");
    const dispatched = (await f.store.executions.pending())[0];
    if (!dispatched) throw Error("Missing dispatch");
    await f.store.executions.claim(dispatched.acceptance.execution, new Date());
    await f.store.executions.beforeSend(dispatched.acceptance.execution, new Date());
    await f.store.endWorkspaceRuntime(f.id, f.runtime.incarnationId, new Date());
    expect(await f.store.managed.requests.get(f.keyId, second, good.request.requestId)).toMatchObject({
      state: "terminal",
      outcome: "lost",
      collection: { state: "settled", completeness: "lost" },
    });
    const [row] = await f.context.db
      .select()
      .from(f.context.tables.managedSessions)
      .where(eq(f.context.tables.managedSessions.sessionId, second));
    expect(row?.queueCount).toBe(1);
    await f.store.managed.requests.completeCleanup(f.id);
    const [cleaned] = await f.context.db
      .select()
      .from(f.context.tables.managedSessions)
      .where(eq(f.context.tables.managedSessions.sessionId, second));
    expect(cleaned?.queueCount).toBe(0);
  } finally {
    await f.dispose();
  }
});

test("a refused prepared request never dispatches after new work clears the refusal", async () => {
  const f = await sessionWorkFixture();
  try {
    const identity = { principalId: f.principal.id, sessionId: f.sessionId };
    await f.store.managed.sessions.bind(identity, 0, {
      workspaceId: f.id,
      incarnationId: f.runtime.incarnationId,
      generation: 1,
    });
    const body = input();
    await f.store.managed.requests.accept(f.keyId, f.sessionId, body, limits);
    await f.store.managed.requests.prepare(new Date());
    expect(await f.store.executions.pending()).toHaveLength(1);
    await f.store.managed.requests.refuse(
      {
        ...identity,
        generation: 1,
        incarnationId: f.runtime.incarnationId,
        profile: f.profile.name,
        owner: "test-owner",
        group: "test-owner",
        slot: "gateway",
        issuer: "gateway",
      },
      new Date(),
    );
    expect((await f.store.managed.requests.get(f.keyId, f.sessionId, body.requestId)).reasonCode).toBe(
      "credentials_refused",
    );
    expect(await f.store.executions.pending()).toHaveLength(0);
    const next = await f.store.managed.requests.accept(f.keyId, f.sessionId, input(), limits);
    await f.store.managed.requests.prepare(new Date());
    expect((await f.store.executions.pending()).map((r) => r.acceptance.execution.requestId)).toEqual([
      next.request.turnId,
    ]);
  } finally {
    await f.dispose();
  }
});
