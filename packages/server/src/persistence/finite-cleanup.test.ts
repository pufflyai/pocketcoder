import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finiteOutputMounts } from "@pstdio/pocketcoder-contracts";
import { createPGliteFixture, executionFixture, insertTestWorkspace } from "@pstdio/pocketcoder-db/testing";
import { FilesystemStorageDriver } from "@pstdio/pocketcoder-drivers";
import { DEFAULT_LIMITS, Scheduler } from "@pstdio/pocketcoder-runtime-core";
import { FakeDriver } from "@pstdio/pocketcoder-testkit";
import { finiteExportCleanup, finiteExports } from "./finite-exports";

test.each(["deletion", "missing-driver"])(
  "failed staging cleanup (%s) remains pending and retries after a scheduler restart",
  async (mode) => {
    const f = await executionFixture();
    const root = await mkdtemp(join(tmpdir(), "pc-finite-cleanup-"));
    try {
      let now = new Date();
      const acceptance = f.acceptance();
      await f.store.executions.accept(acceptance, now);
      await f.store.executions.claim(acceptance.execution, now);
      await f.store.executions.observe(acceptance.execution, acceptance.fingerprint, "terminal", 1, now, {
        exitCode: 0,
      });
      await f.store.executions.acknowledge(acceptance.execution, acceptance.fingerprint, now);
      const storage = new FilesystemStorageDriver({
        workspaceRoot: join(root, "work"),
        checkpointRoot: join(root, "checkpoints"),
      });
      const id = randomUUID();
      const mounts = finiteOutputMounts(f.runtime.template.manifest.spec);
      const allocated = await storage.allocate({
        storageId: id,
        workspaceId: f.id,
        mounts,
        uid: process.getuid?.() ?? 1000,
        gid: process.getgid?.() ?? 1000,
      });
      const marker = join(String(allocated.ref.root), "finite-output-0", "result.txt");
      await Bun.write(marker, "retained bytes");
      await f.store.insertWorkspaceStorage({
        id,
        workspaceId: f.id,
        principalId: f.principal.id,
        providerKind: storage.kind,
        providerRef: allocated.ref,
        mountManifest: mounts,
        state: "ready",
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        retainedUntil: null,
        logicalBytes: null,
        fileCount: null,
        lastErrorCode: null,
      });
      const deleteStorage = storage.deleteStorage.bind(storage);
      let unavailable = true;
      storage.deleteStorage = async (ref) => {
        if (unavailable) throw new Error("storage temporarily unavailable");
        await deleteStorage(ref);
      };
      const deps = {
        store: f.store,
        driver: new FakeDriver(),
        storageDriver: mode === "missing-driver" ? undefined : storage,
        now: () => now,
        onError() {},
        connections: { isConnected: () => false, shutdown: () => false, signal: () => false, close() {} },
        secrets: { generate: () => randomUUID(), digest: (value: string) => new TextEncoder().encode(value) },
        limits: DEFAULT_LIMITS,
        workspaceServerUrl: "http://localhost",
        finalizeOutputs: finiteExports({
          store: f.store,
          storageDriver: mode === "missing-driver" ? undefined : storage,
        }),
        completeOutputCleanup: finiteExportCleanup(f.store),
      };
      const row = await f.store.getWorkspace(f.id);
      if (!row) throw new Error("Workspace missing");
      await new Scheduler(deps).finalize(row, "succeeded", "child_exit_success", now);
      expect((await f.store.getWorkspace(f.id))?.state).toBe("terminating");
      expect((await f.store.executions.get(acceptance.execution))?.collection?.cleanupState).toBe("pending");
      expect((await f.store.getWorkspaceStorage(f.id))?.lastErrorCode).toBe("storage_cleanup_failed");
      expect(await Bun.file(marker).text()).toBe("retained bytes");
      unavailable = false;
      deps.storageDriver = storage;
      now = new Date(now.getTime() + 120000);
      await new Scheduler(deps).sweep();
      expect((await f.store.getWorkspace(f.id))?.state).toBe("succeeded");
      expect((await f.store.executions.get(acceptance.execution))?.collection?.cleanupState).toBe("complete");
      expect((await f.store.getStorage(id))?.state).toBe("deleted");
      expect((await f.store.getStorage(id))?.lastErrorCode).toBeNull();
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      await f.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("an exhausted launch keeps failed storage deletion in the termination retry sweep", async () => {
  const f = await createPGliteFixture("launch-storage-cleanup", "memory");
  const root = await mkdtemp(join(tmpdir(), "pc-launch-cleanup-"));
  try {
    const row = await insertTestWorkspace(f, randomUUID());
    let now = new Date();
    let unavailable = true;
    const storage = new FilesystemStorageDriver({
      workspaceRoot: join(root, "work"),
      checkpointRoot: join(root, "checkpoints"),
    });
    const deleteStorage = storage.deleteStorage.bind(storage);
    storage.deleteStorage = async (ref) => {
      if (unavailable) throw new Error("storage temporarily unavailable");
      await deleteStorage(ref);
    };
    const driver = new FakeDriver();
    driver.create = async () => {
      throw new Error("launch refused");
    };
    const deps = {
      store: f.store,
      driver,
      storageDriver: storage,
      now: () => now,
      onError() {},
      connections: { isConnected: () => false, shutdown: () => false, signal: () => false, close() {} },
      secrets: { generate: () => randomUUID(), digest: (value: string) => new TextEncoder().encode(value) },
      limits: { ...DEFAULT_LIMITS, maxLaunchAttempts: 1 },
      workspaceServerUrl: "http://localhost",
    };
    await new Scheduler(deps).tick();
    expect((await f.store.getWorkspace(row.id))?.state).toBe("terminating");
    expect((await f.store.getWorkspaceStorage(row.id))?.lastErrorCode).toBe("storage_cleanup_failed");
    const allocation = await f.store.getWorkspaceStorage(row.id);
    if (!allocation) throw new Error("Allocation missing");
    unavailable = false;
    now = new Date(now.getTime() + 120000);
    await new Scheduler(deps).sweep();
    expect((await f.store.getWorkspace(row.id))?.state).toBe("failed");
    expect((await f.store.getWorkspace(row.id))?.reasonCode).toBe("launch_failed");
    expect((await f.store.getStorage(allocation.id))?.state).toBe("deleted");
  } finally {
    await f.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
