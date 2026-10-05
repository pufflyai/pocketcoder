import { expect, test } from "bun:test";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { FakeDriver } from "@pstdio/pocketcoder-testkit";
import { DEFAULT_LIMITS, resolveWarmPools, Scheduler, type Store, WarmPoolManager } from "../index";
import { Assignments, noWorkspaceConnections, queue, secrets, seed } from "./warm-pool-fixtures.test";

const createStore = createTestStoreFactory();

type Timing = { method: string; ms: number };
function profileStore(target: Store) {
  const trace: Timing[] = [];
  const store = new Proxy(target, {
    get(target, name) {
      const value = Reflect.get(target, name);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const started = performance.now();
        try {
          return await Reflect.apply(value, target, args);
        } finally {
          trace.push({ method: String(name), ms: performance.now() - started });
        }
      };
    },
  });
  return { store, trace };
}

async function measureAdmission(
  store: Store,
  scheduler: Scheduler,
  seeded: Awaited<ReturnType<typeof seed>>,
  name: string,
  mode: "cold" | "warm",
  trace: Timing[],
) {
  const workspace = await queue(store, seeded, name);
  trace.length = 0;
  const started = performance.now();
  await scheduler.admit();
  const elapsed = performance.now() - started;
  const admissionTrace = [...trace];
  expect(await store.getWorkspace(workspace.id)).toMatchObject({ state: "provisioning", provisioningMode: mode });
  return { elapsed, trace: admissionTrace };
}

test("warm p95 removes provider creation and beats the cached cold path by 80%", async () => {
  // With fewer than 20 samples, nearest-rank p95 is just the maximum.
  const samples = 40;
  const limits = { ...DEFAULT_LIMITS, perPrincipalActiveWorkspaces: samples };
  const coldProfile = profileStore(await createStore());
  const coldStore = coldProfile.store;
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

  const warmProfile = profileStore(await createStore());
  const warmStore = warmProfile.store;
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
  const profiles: Array<{ mode: string; sample: number; elapsed: number; trace: Timing[] }> = [];
  for (let index = 0; index < samples; index += 1) {
    const coldSample = async () => {
      const result = await measureAdmission(
        coldStore,
        coldScheduler,
        coldSeeded,
        `cold-${index}`,
        "cold",
        coldProfile.trace,
      );
      profiles.push({ mode: "cold", sample: index, ...result });
      return result.elapsed;
    };
    const warmSample = async () => {
      const result = await measureAdmission(
        warmStore,
        warmScheduler,
        warmSeeded,
        `warm-${index}`,
        "warm",
        warmProfile.trace,
      );
      profiles.push({ mode: "warm", sample: index, ...result });
      return result.elapsed;
    };
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
  console.log(JSON.stringify({ benchmark: "warm-pool-store-profile", profiles }));
  expect(p95(warm)).toBeLessThanOrEqual(p95(cold) * 0.2);
  expect(warmDriver.created).toHaveLength(0);
});
