import { expect, test } from "bun:test";
import { createPGliteFixture, createTestStoreFactory, insertTestWorkspace } from "@pstdio/pocketcoder-db/testing";
import { FakeDriver } from "@pstdio/pocketcoder-testkit";
import { RuntimeMetrics } from "../observability/metrics";
import { reconcilePersistence } from "./persistence-reconcile";
import { reconcileProviderRow, reconcileProviders } from "./reconcile";

const createStore = createTestStoreFactory();

test("reconciliation records outcomes and durations", async () => {
  const store = await createStore();
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

test("provider disappearance keeps capacity charged until termination is proved", async () => {
  const f = await createPGliteFixture("pc-lost-provider");
  try {
    const row = await insertTestWorkspace(f, "lost");
    const now = new Date();
    await f.store.transition(row.id, { from: ["queued"], to: "provisioning", at: now });
    await f.store.transition(row.id, { from: ["provisioning"], to: "connected", at: now });
    await f.store.transition(row.id, { from: ["connected"], to: "ready", at: now });
    await f.store.updateWorkspace(
      row.id,
      { providerKind: "kubernetes", providerRef: { kind: "kubernetes", id: "missing-job" } },
      now,
    );
    const active = await f.store.getWorkspace(row.id);
    if (!active) throw new Error("Workspace missing");
    await reconcileProviderRow({ store: f.store }, active, undefined, now);
    expect(await f.store.getWorkspace(row.id)).toMatchObject({
      state: "terminating",
      terminalIntent: "failed",
      reasonCode: "provider_lost",
      terminalAt: null,
    });
    expect((await f.store.countActive()).global).toBe(1);
  } finally {
    await f.dispose();
  }
});
