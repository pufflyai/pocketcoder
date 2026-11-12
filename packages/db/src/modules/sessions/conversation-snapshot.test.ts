import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { managedFixture, provision } from "../managed/fixture.test";

test("pruning during a delta read resets without losing request receipts", async () => {
  const f = await managedFixture("disk");
  if (f.context.driver !== "pglite") throw new Error("Expected embedded store");
  const client = f.context.client;
  const transaction = client.transaction.bind(client);
  try {
    await provision(f);
    const first = await f.store.managed.history.snapshot(f.keyId, f.sessionId);
    const after = { records: first.recordCursor, events: Number(first.eventCursor.split(":")[1]) };
    const ids = [randomUUID(), randomUUID()];
    for (const requestId of ids)
      await f.store.managed.requests.accept(
        f.keyId,
        f.sessionId,
        { requestId, message: "waiting", attachments: [] },
        { count: 4, bytes: 1048576 },
      );
    let pruned = false;
    client.transaction = (work) =>
      transaction(async (tx) => {
        const original = tx.query.bind(tx);
        tx.query = (async (...args: Parameters<typeof tx.query>) => {
          if (
            !pruned &&
            /^select/i.test(args[0]) &&
            args[0].includes('"managed_observations"') &&
            !args[0].includes("min(")
          ) {
            pruned = true;
            await original(
              `DELETE FROM "${f.context.schema}"."managed_observations"
          WHERE principal_id=$1 AND session_id=$2 AND sequence <= $3`,
              [f.principal.id, f.sessionId, after.events + 1],
            );
          }
          return original(...args);
        }) as typeof tx.query;
        return work(tx);
      });
    const delta = await f.store.managed.history.snapshot(f.keyId, f.sessionId, after);
    expect(pruned).toBe(true);
    expect(delta.reset).toBe(true);
    expect(delta.requests.map((request) => request.requestId).sort()).toEqual(ids.sort());
  } finally {
    client.transaction = transaction;
    await f.dispose();
  }
});
