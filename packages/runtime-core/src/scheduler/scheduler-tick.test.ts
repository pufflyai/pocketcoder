import { expect, test } from "bun:test";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { FakeDriver } from "@pstdio/pocketcoder-testkit";
import { DEFAULT_LIMITS, Scheduler } from "../index";
import { noWorkspaceConnections, queue, secrets, seed } from "../warm-pool/warm-pool-fixtures.test";

const createStore = createTestStoreFactory();

test("a tick requested during provider creation admits new arrivals before draining", async () => {
  const store = await createStore();
  const seeded = await seed(store);
  const driver = new FakeDriver();
  driver.createDelayMs = 100;
  const scheduler = new Scheduler({
    store,
    driver,
    connections: noWorkspaceConnections,
    secrets,
    limits: DEFAULT_LIMITS,
    workspaceServerUrl: "http://127.0.0.1:8091",
  });
  const first = await queue(store, seeded, "first");
  const running = scheduler.tick();
  const deadline = Date.now() + 1000;
  while ((await store.getWorkspace(first.id))?.state !== "provisioning") {
    if (Date.now() >= deadline) throw new Error("first admission did not start");
    await Bun.sleep(1);
  }
  const second = await queue(store, seeded, "second");
  const requested = scheduler.tick();
  await scheduler.drain();
  await Promise.all([running, requested]);
  expect(driver.created.map((launch) => launch.workspace.id)).toEqual([first.id, second.id]);
  expect((await store.getWorkspace(second.id))?.providerRef).not.toBeNull();
});
