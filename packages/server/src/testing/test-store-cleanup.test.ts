import { expect, test } from "bun:test";
import { createTestStore } from "@pstdio/pocketcoder-db/testing";
import { insertReadyCheckpoint, server, waitFor } from "../persistence/persistence-support.test";
import { failedAllocation } from "../persistence/purge-support.test";
import { authed, createTestBody, createTestServer } from "./test-server.test";

test("a reset drains the preceding server's launch before accepting new rows", async () => {
  const fixture = await createTestStore();
  try {
    const oldServer = await createTestServer(fixture.store);
    oldServer.driver.createDelayMs = 50;
    await oldServer.app.request(
      "/v1/workspaces",
      authed(oldServer.token, {
        method: "POST",
        headers: { "idempotency-key": "old" },
        body: createTestBody("old"),
      }),
    );
    await fixture.reset();
    const nextServer = await createTestServer(fixture.store);
    await nextServer.app.request(
      "/v1/workspaces",
      authed(nextServer.token, {
        method: "POST",
        headers: { "idempotency-key": "next" },
        body: createTestBody("next"),
      }),
    );
    await oldServer.scheduler.drain();
    await nextServer.scheduler.drain();
    expect(oldServer.driver.created).toHaveLength(1);
    expect(nextServer.driver.created).toHaveLength(1);
    await fixture.reset();
  } finally {
    await fixture.dispose();
  }
});

test("a reset waits for an admitted snapshot before removing its rows and files", async () => {
  const fixture = await createTestStore();
  let release = () => {};
  try {
    const app = await server(fixture.store);
    const checkpointId = await insertReadyCheckpoint(app);
    const checkpoint = await app.store.getCheckpoint(checkpointId);
    if (!checkpoint) throw new Error("missing fixture checkpoint");
    const now = new Date();
    await app.store.transition(checkpoint.workspaceId, { from: ["provisioning"], to: "connected", at: now });
    await app.store.transition(checkpoint.workspaceId, { from: ["connected"], to: "ready", at: now });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const snapshot = app.storageDriver.snapshot.bind(app.storageDriver);
    app.storageDriver.snapshot = async (...args) => {
      await gate;
      return snapshot(...args);
    };
    await app.request(`/v1/workspaces/${checkpoint.workspaceId}/preserve`, {
      method: "POST",
      headers: { "idempotency-key": "delayed-snapshot" },
      body: "{}",
    });
    let finished = false;
    const reset = fixture.reset().then(() => {
      finished = true;
    });
    await Bun.sleep(25);
    const finishedBeforeSnapshot = finished;
    release();
    await reset;
    expect(finishedBeforeSnapshot).toBe(false);
    expect(await fixture.store.listPrincipals()).toEqual([]);
  } finally {
    release();
    await fixture.dispose();
  }
});

test("a reset drains an admitted purge before removing its files", async () => {
  const fixture = await createTestStore();
  let release = () => {};
  try {
    const app = await failedAllocation(fixture.store);
    let deleting = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const remove = app.storageDriver.deleteStorage.bind(app.storageDriver);
    app.storageDriver.deleteStorage = async (ref) => {
      deleting = true;
      await gate;
      await remove(ref);
    };
    await app.purge();
    await waitFor(async () => deleting);
    let finished = false;
    const reset = fixture.reset().then(() => {
      finished = true;
    });
    await Bun.sleep(25);
    const finishedBeforeDeletion = finished;
    release();
    await reset;
    expect(finishedBeforeDeletion).toBe(false);
    expect(await fixture.store.listPrincipals()).toEqual([]);
  } finally {
    release();
    await fixture.dispose();
  }
});
