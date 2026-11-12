import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { fakeProducer, managedFixture } from "./managed-fixture.test";
import { sdkClient } from "./sdk-fixture.test";

test("conversation deltas read only records and requests newer than their durable watermark", async () => {
  const producer = fakeProducer();
  const m = await managedFixture(producer.server.port);
  try {
    const session = await m.session();
    for (let i = 0; i < 3; i++) {
      await m.submit(session, `complete ${i}`);
      await m.settle();
    }
    const first = await m.f.store.managed.history.snapshot(m.keyId, session);
    const after = { records: first.records.length, events: Number(first.eventCursor.split(":")[1]) };
    const context = m.f.store.context;
    let largestRead = 0;
    const transaction = context.driver === "pglite" ? context.client.transaction.bind(context.client) : undefined;
    if (context.driver === "pglite" && transaction)
      context.client.transaction = (work) =>
        transaction(async (tx) => {
          const query = tx.query.bind(tx);
          tx.query = (async (...args: Parameters<typeof query>) => {
            const result = await query(...args);
            largestRead = Math.max(largestRead, result.rows.length);
            return result;
          }) as typeof query;
          return work(tx);
        });
    const empty = await m.f.store.managed.history.snapshot(m.keyId, session, after);
    if (context.driver === "pglite" && transaction) context.client.transaction = transaction;
    expect(largestRead).toBeLessThanOrEqual(1);
    expect(empty.records).toEqual([]);
    expect(empty.requests).toEqual([]);
    const late = await m.submit(session, "complete late");
    await m.settle();
    const changes = await m.f.store.managed.history.snapshot(m.keyId, session, after);
    expect(changes.records).toHaveLength(1);
    expect(changes.requests.map((request) => request.requestId)).toEqual([late]);
    expect(changes.recordCursor).toBe(4);
    expect(changes.reset).toBe(false);
    await m.f.store.managed.history.prune(1);
    const expired = await m.f.store.managed.history.snapshot(m.keyId, session, after);
    expect(expired.reset).toBe(true);
    expect(expired.records).toHaveLength(4);
  } finally {
    await m.f.dispose();
    await producer.server.stop(true);
  }
});

test("conversation deltas include live revisions and the final committed message", async () => {
  const producer = fakeProducer();
  const m = await managedFixture(producer.server.port);
  try {
    const { client, server } = await sdkClient(m);
    const session = await m.session();
    const initial = await client.sessions.conversation(session);
    const requestId = await m.submit(session, "stream this turn");
    await m.settle();
    const request = await m.request(session, requestId);
    const table = m.f.store.context.tables.conversationRequests;
    const [accepted] = await m.f.store.context.db.select().from(table).where(eq(table.requestId, requestId));
    if (!accepted) throw new Error("Missing accepted request");
    const messageId = randomUUID();
    const identity = { ...accepted.identity, event_id: messageId, message_id: messageId, sequence: 0, revision: 1 };
    const send = (revision: number, content: string, terminal = false) =>
      server.liveTurns.receive(m.f.id, {
        message_id: messageId,
        role: "assistant",
        content,
        occurred_at: new Date().toISOString(),
        metadata: {},
        identity: {
          ...identity,
          revision,
          ...(terminal ? { fact: { type: "turn_terminal" as const, outcome: "completed" as const } } : {}),
        },
      });
    await send(1, "par");
    const partial = await client.sessions.conversation(session, { after: initial.cursor });
    expect(partial.messages).toMatchObject([
      { requestId, turnId: request.turnId, final: false, parts: [{ type: "text", text: "par" }] },
    ]);
    expect((await client.sessions.conversation(session, { after: partial.cursor })).messages).toEqual([]);
    await send(2, "partial answer");
    const changed = await client.sessions.conversation(session, { after: partial.cursor });
    expect(changed.messages).toMatchObject([
      { messageId, final: false, parts: [{ type: "text", text: "partial answer" }] },
    ]);
    await send(3, "final answer", true);
    const final = await client.sessions.conversation(session, { after: changed.cursor });
    expect(final.messages).toMatchObject([{ messageId, final: true, parts: [{ type: "text", text: "final answer" }] }]);
    expect((await client.sessions.conversation(session, { after: final.cursor })).messages).toEqual([]);
  } finally {
    await m.f.dispose();
    await producer.server.stop(true);
  }
});
