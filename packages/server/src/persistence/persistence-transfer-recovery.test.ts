import { expect, test } from "bun:test";
import { join } from "node:path";
import { FilesystemStorageDriver } from "@pstdio/pocketcoder-drivers";
import { DEFAULT_LIMITS, reconcilePersistence } from "@pstdio/pocketcoder-runtime-core";
import { FakeDriver } from "@pstdio/pocketcoder-testkit";
import { eq } from "drizzle-orm";
import { buildServer } from "../app";
import { checkpointHttpFixture } from "./checkpoint-transfer-fixture.test";
import { PersistenceService } from "./persistence";

test.each(["connected", "preserving"] as const)(
  "restart reconciles a pending %s preserve without stopping its active source",
  async (state) => {
    const f = await checkpointHttpFixture();
    const driver = new FakeDriver();
    const storageDriver = new FilesystemStorageDriver({
      workspaceRoot: join(f.directory, "live"),
      checkpointRoot: join(f.directory, "legacy"),
    });
    const built = buildServer({
      store: f.store,
      driver,
      pepper: "restart-admission-test",
      limits: DEFAULT_LIMITS,
      workspaceServerUrl: "http://127.0.0.1:8090",
    });
    const persistence = new PersistenceService({
      store: f.store,
      driver,
      storageDriver,
      hub: f.hub,
      scheduler: built.scheduler,
      workspaces: built.service,
      maxQueuedWorkspaces: 10,
      checkpointTransfers: f.service,
    });
    try {
      await f.store.updateOperation(f.operationId, { state: "pending" }, new Date());
      await f.context.db
        .update(f.context.tables.workspaces)
        .set({ state })
        .where(eq(f.context.tables.workspaces.id, f.workspace.id));
      await reconcilePersistence({
        store: f.store,
        driver,
        storageDriver,
        reconcileCheckpointOperation: persistence.reconcileCheckpointOperation,
      });
      expect((await f.store.getOperation(f.operationId))?.state).toBe(state === "connected" ? "failed" : "pending");
      expect((await f.store.getCheckpoint(f.checkpoint.id))?.state).toBe(state === "connected" ? "failed" : "creating");
      expect((await f.store.getWorkspace(f.workspace.id))?.state).toBe(state);
      expect(driver.stopped).toEqual([]);
      expect(driver.terminated).toEqual([]);
    } finally {
      await built.scheduler.drain();
      await f.dispose();
    }
  },
);
