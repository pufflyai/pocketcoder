import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { fakeProducer, managedFixture } from "./managed-fixture.test";

test("a controller restart while the producer keeps running yields one completed record", async () => {
  const producer = fakeProducer();
  const m = await managedFixture(producer.server.port);
  try {
    const sessionId = await m.session();
    const requestId = await m.submit(sessionId, "run long");
    await m.settle();
    const running = await m.request(sessionId, requestId);
    expect(running.state).toBe("running");

    // Startup and workspace-end shortcuts must not freeze a placeholder for a managed request.
    await m.f.store.recordInterruptedTurns(new Date());
    const placeholder = await m.f.store.commitConversationTurn({
      workspaceId: m.f.id,
      identity: {
        schema: "pocketcoder.conversation/v2",
        authority: "generic",
        conversation_id: sessionId,
        request_id: requestId,
        turn_id: running.turnId,
        request_fingerprint: running.inputFingerprint.slice(7),
      },
      status: "interrupted",
      reason: "workspace_ended",
      messages: [],
      startedAt: null,
      endedAt: new Date(),
    });
    expect(placeholder.record).toBeNull();
    expect((await m.f.store.managed.history.history(m.keyId, sessionId, null, 50)).records).toEqual([]);

    producer.complete(running.turnId, "finished after restart");
    await m.settle();
    const page = await m.f.store.managed.history.history(m.keyId, sessionId, null, 50);
    expect(page.records).toHaveLength(1);
    expect(page.records[0]).toMatchObject({ status: "completed", final_response: "finished after restart" });
    expect(page.records[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "system"]);
    expect(await m.request(sessionId, requestId)).toMatchObject({ outcome: "completed" });
  } finally {
    await m.f.dispose();
    await producer.server.stop(true);
  }
});

test("a lost producer records the proved loss without inventing an answer", async () => {
  const producer = fakeProducer();
  const m = await managedFixture(producer.server.port);
  try {
    const sessionId = await m.session();
    const requestId = await m.submit(sessionId, "run lost");
    await m.settle();
    await m.f.store.endWorkspaceRuntime(m.f.id, m.f.runtime.incarnationId, new Date());
    const request = await m.request(sessionId, requestId);
    expect(request).toMatchObject({ state: "terminal", outcome: "lost", finalResponse: null });
    const [record] = (await m.f.store.managed.history.history(m.keyId, sessionId, null, 50)).records;
    expect(record).toMatchObject({ status: "lost", final_response: null });
    expect(record?.messages.some((message) => message.role === "assistant")).toBe(false);
  } finally {
    await m.f.dispose();
    await producer.server.stop(true);
  }
});

test("replay after a snapshot watermark misses no accepted work and keeps event identities", async () => {
  const producer = fakeProducer();
  const m = await managedFixture(producer.server.port);
  try {
    const sessionId = await m.session();
    for (const message of ["complete one", "complete two", "complete three"]) await m.submit(sessionId, message);
    await m.settle(6);
    const first = await m.f.store.managed.history.history(m.keyId, sessionId, null, 2);
    expect(first.records).toHaveLength(2);
    // Work that commits between pages lands after the watermark, never in a gap.
    const late = await m.submit(sessionId, "complete late");
    await m.settle();
    const second = await m.f.store.managed.history.history(m.keyId, sessionId, first.nextCursor, 2);
    expect(second.records).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(second.eventCursor).toBe(first.eventCursor);
    const replay = await m.f.store.managed.history.events(m.keyId, sessionId, first.eventCursor, 100);
    const lateEvents = replay.filter((event) => event.requestId === late);
    expect(lateEvents.map((event) => event.kind === "request.updated" && event.data.state)).toContain("terminal");
    const again = await m.f.store.managed.history.events(m.keyId, sessionId, first.eventCursor, 100);
    expect(again.map((event) => [event.eventId, event.revision])).toEqual(
      replay.map((event) => [event.eventId, event.revision]),
    );
    expect(JSON.stringify(replay)).not.toContain("fixture-single-use");
    // A later snapshot contains the late record.
    const fresh = await m.f.store.managed.history.history(m.keyId, sessionId, null, 50);
    expect(fresh.records).toHaveLength(4);
  } finally {
    await m.f.dispose();
    await producer.server.stop(true);
  }
});

test("expired, foreign and future cursors have distinct safe results", async () => {
  const producer = fakeProducer();
  const m = await managedFixture(producer.server.port);
  try {
    const [a, b] = [await m.session(), await m.session()];
    await m.submit(a, "complete one");
    await m.settle();
    const events = await m.f.store.managed.history.events(m.keyId, a, null, 100);
    expect(events[0]?.sequence).toBe(1);
    const tail = events.at(-1)?.cursor ?? "";
    await expect(m.f.store.managed.history.events(m.keyId, b, tail, 10)).rejects.toMatchObject({
      code: "events.cursor_invalid",
    });
    await expect(m.f.store.managed.history.events(m.keyId, a, `${a}:${10 ** 6}`, 10)).rejects.toMatchObject({
      code: "events.cursor_invalid",
    });
    const page = await m.f.store.managed.history.history(m.keyId, a, null, 1);
    await expect(m.f.store.managed.history.history(m.keyId, b, page.nextCursor ?? "x", 1)).rejects.toMatchObject({
      code: "events.cursor_invalid",
    });
    expect(await m.f.store.managed.history.prune(1)).toBeGreaterThan(0);
    await expect(m.f.store.managed.history.events(m.keyId, a, `${a}:0`, 10)).rejects.toMatchObject({
      code: "events.cursor_expired",
    });
    expect(await m.f.store.managed.history.events(m.keyId, a, tail, 10)).toEqual([]);
    // History and request receipts outlive the event retention bound.
    expect((await m.f.store.managed.history.history(m.keyId, a, null, 50)).records).toHaveLength(1);
    const stranger = randomUUID();
    await expect(m.f.store.managed.history.events(stranger, a, null, 10)).rejects.toBeDefined();
  } finally {
    await m.f.dispose();
    await producer.server.stop(true);
  }
});
