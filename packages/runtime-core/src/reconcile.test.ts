import { expect, test } from "bun:test";
import { MemoryStore } from "@pstdio/pocketcoder-memory-store";
import { FakeDriver } from "@pstdio/pocketcoder-testkit";
import { RuntimeMetrics } from "./metrics";
import { reconcilePersistence } from "./persistence-reconcile";
import { reconcileProviders } from "./reconcile";

test("reconciliation records outcomes and durations", async () => {
	const store = new MemoryStore();
	const driver = new FakeDriver();
	const metrics = new RuntimeMetrics();

	await reconcileProviders({ store, driver, metrics });
	await reconcilePersistence({ store, driver, metrics });

	expect(metrics.snapshot()).toEqual({
		counters: {
			'reconciliation.total{kind="persistence",result="skipped"}': 1,
			'reconciliation.total{kind="provider",result="succeeded"}': 1,
		},
		timings: {
			'reconciliation.duration_ms{kind="persistence",result="skipped"}': {
				count: 1,
				total: expect.any(Number),
				min: expect.any(Number),
				max: expect.any(Number),
			},
			'reconciliation.duration_ms{kind="provider",result="succeeded"}': {
				count: 1,
				total: expect.any(Number),
				min: expect.any(Number),
				max: expect.any(Number),
			},
		},
	});
});
