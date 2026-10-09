import { expect, test } from "bun:test";
import { createTestStore, createTestStoreFactory, registerTestCleanup } from "./test-fixtures";

const createStore = createTestStoreFactory();

test("test stores remain independent within the same test", async () => {
  const first = await createStore();
  const second = await createStore();
  await first.createPrincipal("first", ["admin"], ["*"]);
  expect((await first.listPrincipals()).map((row) => row.name)).toEqual(["first"]);
  expect(await second.listPrincipals()).toEqual([]);
});

test("the next test starts with no rows from the preceding test", async () => {
  const store = await createStore();
  expect(await store.listPrincipals()).toEqual([]);
  await store.createPrincipal("next", ["admin"], ["*"]);
  expect((await store.listPrincipals()).map((row) => row.name)).toEqual(["next"]);
});

test("reset drains old writes and clears the coordinator lease", async () => {
  const fixture = await createTestStore();
  try {
    const oldStore = fixture.store;
    await oldStore.acquireCoordinatorLease();
    const write = Bun.sleep(25).then(() => oldStore.createPrincipal("old-job", ["admin"], ["*"]));
    registerTestCleanup(oldStore, async () => {
      await write;
    });
    await fixture.reset();
    expect(await fixture.store.listPrincipals()).toEqual([]);
    const release = await fixture.store.acquireCoordinatorLease();
    await release();
    expect(fixture.store).not.toBe(oldStore);
  } finally {
    await fixture.dispose();
  }
});
