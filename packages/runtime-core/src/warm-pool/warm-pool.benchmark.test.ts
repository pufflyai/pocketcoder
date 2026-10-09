import { expect, test } from "bun:test";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { FakeDriver } from "@pstdio/pocketcoder-testkit";
import { DEFAULT_LIMITS, resolveWarmPools, Scheduler, type Store, WarmPoolManager } from "../index";
import { Assignments, noWorkspaceConnections, queue, secrets, seed } from "./warm-pool-fixtures.test";

const createStore = createTestStoreFactory();

async function measureAdmission(
  store: Store,
  scheduler: Scheduler,
  seeded: Awaited<ReturnType<typeof seed>>,
  name: string,
  mode: "cold" | "warm",
) {
  const workspace = await queue(store, seeded, name);
  const started = performance.now();
  await scheduler.admit();
  const elapsed = performance.now() - started;
  expect(await store.getWorkspace(workspace.id)).toMatchObject({ state: "provisioning", provisioningMode: mode });
  return elapsed;
}

test("warm p95 removes provider creation and beats the cached cold path by 80%", async () => {
  // With fewer than 20 samples, nearest-rank p95 is just the maximum.
  const samples = 40;
  const limits = { ...DEFAULT_LIMITS, perPrincipalActiveWorkspaces: samples };
  const coldStore = await createStore();
  const coldDriver = new FakeDriver();
  coldDriver.createDelayMs = 30;
  const coldSeeded = await seed(coldStore);
  const coldScheduler = new Scheduler({
    store: coldStore,
    driver: coldDriver,
    connections: noWorkspaceConnections,
    secrets,
    limits,
    workspaceServerUrl: "http://127.0.0.1:7080",
  });

  const warmStore = await createStore();
  const warmDriver = new FakeDriver();
  warmDriver.createDelayMs = 30;
  const warmSeeded = await seed(warmStore);
  const pools = await resolveWarmPools(
    warmStore,
    [
      {
        template: warmSeeded.template.name,
        minReady: samples,
        maxWarmAgeMs: 60_000,
        missPolicy: "cold",
        waitTimeoutMs: 1000,
      },
    ],
    warmDriver.kind,
    samples,
  );
  const manager = new WarmPoolManager({
    store: warmStore,
    driver: warmDriver,
    connections: new Assignments(),
    secrets,
    workspaceServerUrl: "http://127.0.0.1:7080",
    pools,
  });
  await manager.reconcile();
  for (const runtime of await warmStore.listWarmPoolRuntimes()) await manager.markReady(runtime.id);
  const warmScheduler = new Scheduler({
    store: warmStore,
    driver: warmDriver,
    connections: noWorkspaceConnections,
    secrets,
    limits,
    workspaceServerUrl: "http://127.0.0.1:7080",
    warmPool: manager,
  });
  const cold: number[] = [];
  const warm: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const coldSample = () => measureAdmission(coldStore, coldScheduler, coldSeeded, `cold-${index}`, "cold");
    const warmSample = () => measureAdmission(warmStore, warmScheduler, warmSeeded, `warm-${index}`, "warm");
    // Alternate the order so background load affects both paths.
    if (index % 2 === 0) {
      cold.push(await coldSample());
      warm.push(await warmSample());
    } else {
      warm.push(await warmSample());
      cold.push(await coldSample());
    }
  }
  const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] ?? 0;
  console.log(JSON.stringify({ benchmark: "warm-pool", cold, warm, coldP95: p95(cold), warmP95: p95(warm) }));
  expect(p95(warm)).toBeLessThanOrEqual(p95(cold) * 0.2);
  expect(warmDriver.created).toHaveLength(0);
});
