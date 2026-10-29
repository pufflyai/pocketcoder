import { expect, test } from "bun:test";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { FakeDriver } from "@pstdio/pocketcoder-testkit";
import { DEFAULT_LIMITS, resolveWarmPools, Scheduler, WarmPoolManager } from "../index";
import { Assignments, noWorkspaceConnections, queue, secrets, seed } from "./warm-pool-fixtures.test";

const createStore = createTestStoreFactory();

test("a stale warm snapshot stays queued and leases the ready runtime on the next admission", async () => {
  const store = await createStore();
  const driver = new FakeDriver();
  const seeded = await seed(store);
  const pools = await resolveWarmPools(
    store,
    [
      {
        template: seeded.template.name,
        minReady: 1,
        maxWarmAgeMs: 60_000,
        missPolicy: "cold",
        waitTimeoutMs: 1000,
      },
    ],
    driver.kind,
    10,
  );
  const assignments = new Assignments();
  const manager = new WarmPoolManager({
    store,
    driver,
    connections: assignments,
    secrets,
    workspaceServerUrl: "http://127.0.0.1:7080",
    pools,
  });
  await manager.reconcile();
  const [runtime] = await store.listWarmPoolRuntimes();
  if (!runtime) throw new Error("warm runtime not found");
  await manager.markReady(runtime.id);
  const workspace = await queue(store, seeded, "changed-output");
  let changed = false;
  const scheduler = new Scheduler({
    store,
    driver,
    connections: noWorkspaceConnections,
    secrets,
    limits: DEFAULT_LIMITS,
    workspaceServerUrl: "http://127.0.0.1:7080",
    warmPool: manager,
    authorizeLaunch: async (row) => {
      if (!changed) {
        changed = true;
        await store.appendOutput({
          workspaceId: row.id,
          name: "artifact",
          value: "new",
          seq: 0,
          occurredAt: new Date(),
        });
      }
      return true;
    },
  });
  await scheduler.admit();
  expect(await store.getWorkspace(workspace.id)).toMatchObject({ state: "queued", outputs: { artifact: "new" } });
  expect(await store.getWarmPoolRuntime(runtime.id)).toMatchObject({ state: "ready", workspaceId: null });
  expect(driver.created).toHaveLength(0);
  expect(assignments.inputs).toHaveLength(0);
  await scheduler.admit();
  expect(await store.getWorkspace(workspace.id)).toMatchObject({ state: "provisioning", provisioningMode: "warm" });
  expect(driver.created).toHaveLength(0);
  expect(assignments.inputs).toEqual([{ runtimeId: runtime.id, workspaceId: workspace.id }]);
});
