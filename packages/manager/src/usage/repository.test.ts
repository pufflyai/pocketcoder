import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createManagerApp } from "../app";
import { accountRepository } from "../database/account-repository";
import { bootstrapRepository } from "../database/bootstrap-repository";
import { managerContext } from "../database/context";
import { lifecycleRepository } from "../database/lifecycle-repository";
import { ManagerStore } from "../database/store";
import { usageRepository } from "./repository";
import { retainedSince } from "./window";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

test("unknown usage stays null, partial minutes are clipped, and storage bytes exceed 32-bit limits", async () => {
  const context = await managerContext();
  cleanups.push(() => context.close());
  const store = { ...accountRepository(context), ...usageRepository(context) };
  const { account } = await store.createAccount("partial", { name: "partial" }, config, new Date(Date.now() + 60_000));
  const start = new Date("2026-10-10T10:00:10Z");
  await context.db
    .update(context.tables.accounts)
    .set({ createdAt: start })
    .where(eq(context.tables.accounts.id, account.id));
  const end = new Date("2026-10-10T10:01:30Z");
  expect(await store.getUsage(account.id, end)).toMatchObject({
    estimated_workspace_seconds: null,
    observed_peak: null,
    volume_bytes: null,
    sampled_at: null,
    coverage: { expected_samples: 2, recorded_samples: 0, workspace_gap_seconds: 80 },
  });
  await store.recordUsageSample({
    accountId: account.id,
    sampledAt: new Date("2026-10-10T10:00:20Z"),
    workspaces: 2,
    warm: 0,
    volumeBytes: 5_000_000_000,
  });
  expect(await store.getUsage(account.id, end)).toMatchObject({
    estimated_workspace_seconds: 100,
    estimated_warm_seconds: 0,
    volume_bytes: 5_000_000_000,
    coverage: { workspace_observed_seconds: 50, workspace_gap_seconds: 30 },
  });
});

test("retention keeps thirteen calendar months including the cutoff and clamps month ends", async () => {
  const context = await managerContext();
  cleanups.push(() => context.close());
  const store = { ...accountRepository(context), ...usageRepository(context) };
  const { account } = await store.createAccount(
    "retention",
    { name: "retention" },
    config,
    new Date(Date.now() + 60_000),
  );
  const now = new Date("2026-10-31T12:00:00Z");
  const cutoff = retainedSince(now);
  expect(cutoff.toISOString()).toBe("2025-09-30T12:00:00.000Z");
  expect(retainedSince(new Date("2025-03-31T12:00:00Z")).toISOString()).toBe("2024-02-29T12:00:00.000Z");
  await context.db
    .update(context.tables.accounts)
    .set({ createdAt: new Date("2025-01-01T00:00:00Z") })
    .where(eq(context.tables.accounts.id, account.id));
  for (const sampledAt of [new Date(+cutoff - 1), cutoff]) {
    await store.recordUsageSample({ accountId: account.id, sampledAt, workspaces: 1, warm: 0, volumeBytes: 1024 });
  }
  await store.pruneUsageSamples(now);
  expect(await context.db.select().from(context.tables.usageSamples)).toHaveLength(1);
  expect(await store.getUsage(account.id, now)).toMatchObject({
    estimated_workspace_seconds: 60,
    coverage: { from: cutoff.toISOString(), recorded_samples: 1 },
  });
});
const config = { controllerImage: `controller.test/server@sha256:${"a".repeat(64)}`, runtimeClassName: "pc-runc" };

test("a usage response reads its totals and latest observation from the same snapshot", async () => {
  const context = await managerContext();
  cleanups.push(() => context.close());
  const store = { ...accountRepository(context), ...usageRepository(context) };
  const { account } = await store.createAccount(
    "concurrent",
    { name: "concurrent" },
    config,
    new Date(Date.now() + 60_000),
  );
  const start = new Date("2026-10-10T09:00:00Z");
  await context.db
    .update(context.tables.accounts)
    .set({ createdAt: start })
    .where(eq(context.tables.accounts.id, account.id));
  const writer = (async () => {
    for (let minute = 0; minute < 20; minute++) {
      await store.recordUsageSample({
        accountId: account.id,
        sampledAt: new Date(+start + minute * 60_000),
        workspaces: 1,
        warm: 0,
        volumeBytes: minute,
      });
    }
  })();
  const reader = (async () => {
    for (let read = 0; read < 20; read++) {
      const usage = await store.getUsage(account.id, new Date(+start + 20 * 60_000));
      if (usage.sampled_at === null) expect(usage.coverage.recorded_samples).toBe(0);
      else expect(usage.coverage.recorded_samples).toBe((+new Date(usage.sampled_at) - +start) / 60_000 + 1);
    }
  })();
  await Promise.all([writer, reader]);
});

test("coverage excludes the next minute at an exact response boundary", async () => {
  const context = await managerContext();
  cleanups.push(() => context.close());
  const store = { ...accountRepository(context), ...usageRepository(context) };
  const { account } = await store.createAccount(
    "boundary",
    { name: "boundary" },
    config,
    new Date(Date.now() + 60_000),
  );
  const start = new Date("2026-10-10T10:00:00Z");
  const boundary = new Date(+start + 60_000);
  await context.db
    .update(context.tables.accounts)
    .set({ createdAt: start })
    .where(eq(context.tables.accounts.id, account.id));
  await store.recordUsageSample({ accountId: account.id, sampledAt: start, workspaces: 1, warm: 0, volumeBytes: 1024 });
  await store.recordUsageSample({
    accountId: account.id,
    sampledAt: boundary,
    workspaces: 5,
    warm: 0,
    volumeBytes: 2048,
  });
  expect(await store.getUsage(account.id, boundary)).toMatchObject({
    estimated_workspace_seconds: 60,
    observed_peak: 1,
    volume_bytes: 1024,
    sampled_at: start.toISOString(),
    coverage: { expected_samples: 1, recorded_samples: 1, workspace_samples: 1, workspace_gap_seconds: 0 },
  });
});

test("usage survives restart, counts each minute once, and exposes observation gaps over HTTP", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc-manager-usage-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const context = await managerContext(directory);
  let store: ManagerStore = {
    ...accountRepository(context),
    ...bootstrapRepository(context),
    ...lifecycleRepository(context),
    ...usageRepository(context),
    close: () => context.close(),
  };
  cleanups.push(() => store.close());
  const token = await store.createOperator(new Date(Date.now() + 60_000));
  const { account } = await store.createAccount("usage", { name: "usage" }, config, new Date(Date.now() + 60_000));
  const start = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 4 * 60_000);
  await context.db
    .update(context.tables.accounts)
    .set({ createdAt: start })
    .where(eq(context.tables.accounts.id, account.id));
  const sample = (minute: number, workspaces: number | null, warm: number | null, volumeBytes: number | null) =>
    store.recordUsageSample({
      accountId: account.id,
      sampledAt: new Date(+start + minute * 60_000),
      workspaces,
      warm,
      volumeBytes,
    });
  await sample(0, 2, 1, 1024);
  await sample(0, 99, 99, 9999);
  await sample(1, null, null, null);
  // Minute two has no sample, as after a manager outage.
  await sample(3, 1, 2, null);
  await store.close();
  store = await ManagerStore.create(directory);
  const usage = await store.getUsage(account.id, new Date(+start + 4 * 60_000));
  expect(usage).toMatchObject({
    estimated_workspace_seconds: 180,
    observed_peak: 2,
    estimated_warm_seconds: 180,
    observed_warm_peak: 2,
    volume_bytes: null,
    sampled_at: new Date(+start + 3 * 60_000).toISOString(),
    coverage: {
      expected_samples: 4,
      recorded_samples: 3,
      workspace_samples: 2,
      volume_samples: 1,
      workspace_observed_seconds: 120,
      workspace_gap_seconds: 120,
      volume_observed_seconds: 60,
      volume_gap_seconds: 180,
    },
  });
  const app = createManagerApp(store, config);
  const path = `/v1/accounts/${account.id}/usage`;
  expect((await app.request(path)).status).toBe(401);
  const response = await app.request(path, { headers: { authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ account_id: account.id, observed_peak: 2, volume_bytes: null });
  expect(
    (await app.request(`/v1/accounts/${crypto.randomUUID()}/usage`, { headers: { authorization: `Bearer ${token}` } }))
      .status,
  ).toBe(404);
});
