import { describe, expect, test } from "bun:test";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { FakeDriver } from "@pstdio/pocketcoder-testkit";
import { DEFAULT_LIMITS, resolveWarmPools, Scheduler, WarmPoolManager } from "../index";
import { Assignments, noWorkspaceConnections, queue, secrets, seed } from "./warm-pool-fixtures.test";

const createStore = createTestStoreFactory();

describe("warm workspace pooling", () => {
  test("requires admission before leasing a ready runtime without cold creation", async () => {
    const store = await createStore();
    const driver = new FakeDriver();
    const seeded = await seed(store);
    const pools = await resolveWarmPools(
      store,
      [
        {
          template: seeded.template.name,
          version: seeded.template.version,
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
    const runtime = (await store.listWarmPoolRuntimes())[0];
    expect(runtime?.providerRef).not.toBeNull();
    expect(await manager.markReady(runtime?.id ?? "")).toBe(true);

    const workspace = await queue(store, seeded, "warm-hit");
    let allowed = false;
    const scheduler = new Scheduler({
      authorizeLaunch: async () => allowed,
      store,
      driver,
      connections: noWorkspaceConnections,
      secrets,
      limits: DEFAULT_LIMITS,
      workspaceServerUrl: "http://127.0.0.1:7080",
      warmPool: manager,
    });
    await scheduler.admit();
    expect(assignments.inputs).toHaveLength(0);
    expect((await store.getWorkspace(workspace.id))?.state).toBe("queued");
    allowed = true;
    await scheduler.admit();

    const after = await store.getWorkspace(workspace.id);
    expect(after?.state).toBe("provisioning");
    expect(after?.provisioningMode).toBe("warm");
    expect(driver.created).toHaveLength(0);
    expect(assignments.inputs).toEqual([{ runtimeId: runtime?.id as string, workspaceId: workspace.id }]);
    expect(manager.metrics.warmHits).toBe(1);
  });

  test("a ready runtime is claimed once and a concurrent miss falls back cold", async () => {
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
    const manager = new WarmPoolManager({
      store,
      driver,
      connections: new Assignments(),
      secrets,
      workspaceServerUrl: "http://127.0.0.1:7080",
      pools,
    });
    await manager.reconcile();
    const runtime = (await store.listWarmPoolRuntimes())[0];
    await manager.markReady(runtime?.id ?? "");
    await queue(store, seeded, "first");
    await queue(store, seeded, "second");
    const scheduler = new Scheduler({
      store,
      driver,
      connections: noWorkspaceConnections,
      secrets,
      limits: DEFAULT_LIMITS,
      workspaceServerUrl: "http://127.0.0.1:7080",
      warmPool: manager,
    });
    await scheduler.admit();
    expect(manager.metrics.warmHits).toBe(1);
    expect(driver.created).toHaveLength(1);
    expect((await store.listWarmPoolRuntimes()).filter((row) => row.workspaceId)).toHaveLength(1);
  });

  test("rejects persistent templates before capacity is served", async () => {
    const store = await createStore();
    const seeded = await seed(store, true);
    await expect(
      resolveWarmPools(
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
        "fake",
        10,
      ),
    ).rejects.toThrow("persistent mounts are not supported");
  });
});
