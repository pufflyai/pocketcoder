import { describe, expect, test } from "bun:test";
import { createPostgresFixture, insertTestWorkspace, TEST_DATABASE_URL } from "../../test-fixtures";

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL outbox claims", () => {
  test("concurrent claims are disjoint and expired leases can be retried", async () => {
    const fixture = await createPostgresFixture("pc40_outbox");
    try {
      const workspace = await insertTestWorkspace(fixture, "outbox");
      const at = new Date(Date.now() + 1000);
      for (let index = 0; index < 5; index += 1) {
        await fixture.store.appendEvent(workspace.id, "custom", { index }, at);
      }
      const [left, right] = await Promise.all([
        fixture.store.claimDueEvents(at, 3),
        fixture.store.claimDueEvents(at, 3),
      ]);
      const claimed = [...left, ...right];
      expect(claimed).toHaveLength(6);
      expect(new Set(claimed.map((row) => row.id)).size).toBe(6);
      expect(await fixture.store.claimDueEvents(at, 6)).toEqual([]);
      const delivered = claimed[0];
      if (!delivered) throw new Error("missing claimed event");
      await fixture.store.markEventDelivered(delivered.id, at);
      const retried = await fixture.store.claimDueEvents(new Date(at.getTime() + 60_001), 6);
      expect(retried).toHaveLength(5);
      expect(retried.some((row) => row.id === delivered.id)).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });

  test("JSON values retain their type in outputs, workspace state, and events", async () => {
    const fixture = await createPostgresFixture("pc40_json");
    try {
      const workspace = await insertTestWorkspace(fixture, "json");
      const at = new Date();
      const values = [null, "quoted string", ["a", 2], { text: "value", nested: { flag: true } }];
      for (const [index, value] of values.entries()) {
        await fixture.store.appendOutput({
          workspaceId: workspace.id,
          seq: 0,
          name: String(index),
          value,
          occurredAt: at,
        });
        await fixture.store.appendEvent(workspace.id, String(index), value, at);
      }
      expect((await fixture.store.listOutputs(workspace.id)).map((row) => row.value)).toEqual(values);
      expect((await fixture.store.getWorkspace(workspace.id))?.outputs).toEqual(
        Object.fromEntries(values.map((value, index) => [String(index), value])),
      );
      const events = await fixture.store.claimDueEvents(new Date(Date.now() + 1000), 10);
      for (const [index, value] of values.entries()) {
        expect(events.find((row) => row.eventType === String(index))?.payload).toEqual(value);
      }
    } finally {
      await fixture.dispose();
    }
  });
});
