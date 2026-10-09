import { expect, test } from "bun:test";
import { createPGliteFixture, insertTestWorkspace } from "../../test-fixtures";

async function connectedFixture() {
  const fixture = await createPGliteFixture("ready-authority", "disk");
  const workspace = await insertTestWorkspace(fixture, "restore-destination");
  const at = new Date();
  await fixture.store.transition(workspace.id, { from: ["queued"], to: "provisioning", at });
  await fixture.store.transition(workspace.id, { from: ["provisioning"], to: "connected", at });
  await fixture.store.updateWorkspace(workspace.id, { connectionEpoch: 5 }, at);
  return { ...fixture, workspace };
}

test("ready transition refuses a superseded connection epoch", async () => {
  const f = await connectedFixture();
  try {
    const history = await f.store.listStateHistory(f.workspace.id);
    const result = await f.store.transition(f.workspace.id, {
      from: ["connected"],
      to: "ready",
      at: new Date(),
      expectedConnectionEpoch: 4,
    });
    expect(result).toBeNull();
    expect((await f.store.getWorkspace(f.workspace.id))?.state).toBe("connected");
    expect(await f.store.listStateHistory(f.workspace.id)).toEqual(history);
  } finally {
    await f.dispose();
  }
});

test.each([2, 3])("ready authority loss at transaction boundary %s rolls back state and history", async (boundary) => {
  const f = await connectedFixture();
  try {
    const before = await f.store.getWorkspace(f.workspace.id);
    const history = await f.store.listStateHistory(f.workspace.id);
    let calls = 0;
    const ready = f.store.transition(f.workspace.id, {
      from: ["connected"],
      to: "ready",
      at: new Date(),
      expectedConnectionEpoch: 5,
      check() {
        if (++calls === boundary) throw new Error("Live restore connection changed.");
      },
    });
    await expect(ready).rejects.toThrow("Live restore connection changed.");
    expect(await f.store.getWorkspace(f.workspace.id)).toEqual(before);
    expect(await f.store.listStateHistory(f.workspace.id)).toEqual(history);
  } finally {
    await f.dispose();
  }
});

test("current ready authority commits", async () => {
  const f = await connectedFixture();
  try {
    const ready = await f.store.transition(f.workspace.id, {
      from: ["connected"],
      to: "ready",
      at: new Date(),
      expectedConnectionEpoch: 5,
      check() {},
    });
    expect(ready?.state).toBe("ready");
  } finally {
    await f.dispose();
  }
});
