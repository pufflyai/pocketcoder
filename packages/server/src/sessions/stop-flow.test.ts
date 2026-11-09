import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { fakeProducer, managedFixture } from "./managed-fixture.test";
import { createSessionRecovery } from "./recovery";

const WINDOW = 30000;

test("cancel stops one queued or running request while a sibling session keeps running", async () => {
  const producer = fakeProducer();
  const m = await managedFixture(producer.server.port);
  try {
    const [a, b] = [await m.session(), await m.session()];
    const a1 = await m.submit(a, "run a1");
    const a2 = await m.submit(a, "run a2");
    const b1 = await m.submit(b, "run b1");
    await m.settle();
    expect((await m.request(a, a1)).state).toBe("running");
    expect((await m.request(a, a2)).state).toBe("accepted");
    expect((await m.request(b, b1)).state).toBe("running");

    // Queued work ends without ever reaching the producer.
    const queued = await m.f.store.managed.requests.cancel(
      m.keyId,
      a,
      a2,
      { cancelId: randomUUID() },
      WINDOW,
      new Date(),
    );
    expect(queued.receipt).toMatchObject({ state: "completed", scope: "request", requestId: a2 });
    expect(queued.executions).toEqual([]);
    expect(await m.request(a, a2)).toMatchObject({
      state: "terminal",
      outcome: "canceled",
      collection: { state: "settled", completeness: "lost" },
    });

    const cancelId = randomUUID();
    const first = await m.f.store.managed.requests.cancel(m.keyId, a, a1, { cancelId }, WINDOW, new Date());
    expect(first.receipt.state).toBe("pending");
    expect(first.executions).toHaveLength(1);
    // A retry after a lost reply keeps the original identity and deadline.
    const retry = await m.f.store.managed.requests.cancel(m.keyId, a, a1, { cancelId }, WINDOW * 4, new Date());
    expect(retry.receipt.cancelDeadline).toBe(first.receipt.cancelDeadline);
    await expect(
      m.f.store.managed.requests.cancel(m.keyId, a, a1, { cancelId: randomUUID() }, WINDOW, new Date()),
    ).rejects.toMatchObject({ code: "idempotency.conflict" });
    for (const record of first.executions) m.f.dispatcher.cancel(record);
    await m.settle();

    // The producer had written final text, but the stop decides the outcome.
    expect(await m.request(a, a1)).toMatchObject({
      state: "terminal",
      outcome: "interrupted",
      finalResponse: "partial answer",
    });
    const done = await m.f.store.managed.requests.cancel(m.keyId, a, a1, { cancelId }, WINDOW, new Date());
    expect(done.receipt).toMatchObject({ state: "completed", cancelDeadline: first.receipt.cancelDeadline });
    expect(producer.sent("run a2")).toEqual([]);
    expect(producer.journal.filter((entry) => entry.action === "cancel").map((entry) => entry.message)).toEqual([
      "run a1",
    ]);
    expect((await m.request(b, b1)).state).toBe("running");
  } finally {
    await m.f.dispose();
    await producer.server.stop(true);
  }
});

test("completion wins over a late cancel and a missed deadline stays pending with its reason", async () => {
  const producer = fakeProducer();
  const m = await managedFixture(producer.server.port);
  try {
    const a = await m.session();
    const done = await m.submit(a, "complete now");
    await m.settle();
    const late = await m.f.store.managed.requests.cancel(
      m.keyId,
      a,
      done,
      { cancelId: randomUUID() },
      WINDOW,
      new Date(),
    );
    expect(late.receipt.state).toBe("completed");
    expect(await m.request(a, done)).toMatchObject({ outcome: "completed", finalResponse: "done:complete now" });

    const stuck = await m.submit(a, "run stuck");
    await m.settle();
    // A producer without a reply to the stop: the receipt never claims completion.
    await m.f.store.managed.requests.cancel(m.keyId, a, stuck, { cancelId: randomUUID() }, 1, new Date());
    await Bun.sleep(5);
    await m.f.store.managed.requests.prepare(new Date());
    const request = await m.request(a, stuck);
    expect(request.state).not.toBe("terminal");
    expect(request.reasonCode).toBe("cancel_deadline_exceeded");
  } finally {
    await m.f.dispose();
    await producer.server.stop(true);
  }
});

test("close fences new work, stops this session only and keeps its history readable", async () => {
  const producer = fakeProducer();
  const m = await managedFixture(producer.server.port);
  try {
    const [a, b] = [await m.session(), await m.session()];
    const finished = await m.submit(a, "complete first");
    await m.settle();
    const running = await m.submit(a, "run a");
    const queued = await m.submit(a, "run queued");
    const sibling = await m.submit(b, "run b");
    await m.settle();

    // A model call that was already sent keeps its hold through the stop.
    const invocation = { principalId: m.f.principal.id, sessionId: a, requestId: running, invocationId: randomUUID() };
    await m.f.store.managed.budgets.reserve({
      requestDigest: `sha256:${"a".repeat(64)}`,
      countEvidenceRef: "fixture-count",
      identity: invocation,
      workspaceId: m.f.id,
      model: "fixture/model",
      inputTokens: 10,
      requestedOutputTokens: 20,
    });
    expect(await m.f.store.managed.budgets.claimSend(invocation)).toBe(true);
    const cancelId = randomUUID();
    const close = await m.f.store.managed.sessions.close(m.keyId, a, { cancelId }, WINDOW, new Date());
    expect(close.receipt).toMatchObject({ scope: "session", requestId: null, state: "pending" });
    await expect(m.submit(a, "after close")).rejects.toMatchObject({ code: "session.closed" });
    for (const record of close.executions) m.f.dispatcher.cancel(record);
    await m.settle();
    // On shared compute, close completes once this session's process stop is recorded.
    const pending = await m.f.store.managed.sessions.close(m.keyId, a, { cancelId }, WINDOW, new Date());
    expect(pending.receipt.state).toBe("pending");
    const launcher = { create: async () => Promise.reject(Error("not expected")), stop: async () => {} };
    await createSessionRecovery({ store: m.f.store, launcher }).tick();
    await m.f.store.managed.requests.prepare(new Date());

    const replay = await m.f.store.managed.sessions.close(m.keyId, a, { cancelId }, WINDOW, new Date());
    expect(replay.receipt).toMatchObject({ state: "completed", cancelDeadline: close.receipt.cancelDeadline });
    expect((await m.f.store.managed.sessions.get(m.keyId, a)).state).toBe("closed");
    expect((await m.request(a, running)).outcome).toBe("interrupted");
    expect((await m.request(a, queued)).outcome).toBe("canceled");
    expect(await m.request(a, finished)).toMatchObject({ outcome: "completed", finalResponse: "done:complete first" });
    expect((await m.request(b, sibling)).state).toBe("running");
    expect(producer.sent("run queued")).toEqual([]);
    expect(await m.f.store.managed.budgets.usage(m.keyId, m.scopeId)).toMatchObject({
      heldInputTokens: 10,
      inFlightModelRequests: 1,
    });
  } finally {
    await m.f.dispose();
    await producer.server.stop(true);
  }
});
