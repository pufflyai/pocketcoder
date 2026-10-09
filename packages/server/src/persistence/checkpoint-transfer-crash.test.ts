import { expect, test } from "bun:test";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PGliteStore } from "@pstdio/pocketcoder-db";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { FakeDriver } from "@pstdio/pocketcoder-testkit";
import { buildServer } from "../app";
import { Hub } from "../control-channel/hub";
import { createCheckpointTransferService } from "./checkpoint-transfer";

type Crash = {
  dataDir: string;
  directory: string;
  checkpointId: string;
  operationId: string;
  workspaceId: string;
  transferId: string;
};
async function crash(phase: string) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "checkpoint-transfer-crash-fixture.ts"), phase], {
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const reader = child.stdout.getReader();
    const part = await reader.read();
    reader.releaseLock();
    if (part.done) throw new Error(await new Response(child.stderr).text());
    return JSON.parse(new TextDecoder().decode(part.value)) as Crash;
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
}
function transfers(store: PGliteStore, directory: string) {
  return createCheckpointTransferService({
    store,
    hub: new Hub(),
    directory,
    agentBaseUrl: "http://127.0.0.1:8090",
    limits: {
      deadlineMs: 3000,
      maxArchiveBytes: 65536,
      maxIndexBytes: 65536,
      maxQueueBytes: 65536,
      maxLedgerBytes: 65536,
    },
    retentionLimits: {
      maxCheckpointFiles: 100,
      maxRetainedBytes: 1_000_000,
      maxRetainedBytesPerPrincipal: 1_000_000,
      maxCheckpointsPerPrincipal: 10,
    },
    readCapacity: () => {
      throw new Error("Recovery must not mint an upload grant.");
    },
  });
}

test.each(["upload", "partial", "rename", "metadata", "committed"])(
  "SIGKILL during %s recovers durable transfer ownership and quota",
  async (phase) => {
    const f = await crash(phase);
    const store = await PGliteStore.create(f.dataDir);
    const service = transfers(store, f.directory);
    try {
      await writeFile(join(f.directory, "unrelated"), "keep");
      expect(await service.reconcile()).toBe(0);
      const row = await store.checkpointTransfers.get(f.transferId);
      const reservation = await store.storageReservations.get(row?.reservationId ?? "");
      const committed = phase === "committed";
      expect(row?.state).toBe(committed ? "complete" : "aborted");
      expect(reservation?.state).toBe(committed ? "committed" : "released");
      const expectedNames = committed ? [`${f.checkpointId}-${f.transferId}.tar`, "unrelated"] : ["unrelated"];
      expect((await readdir(f.directory)).sort()).toEqual(expectedNames.sort());
      const built = buildServer({
        store,
        driver: new FakeDriver(),
        pepper: "crash-test",
        limits: DEFAULT_LIMITS,
        workspaceServerUrl: "http://127.0.0.1:8090",
      });
      // Use the same service the restarted controller composes for persistence recovery.
      const { PersistenceService } = await import("./persistence");
      const persistence = new PersistenceService({
        store,
        driver: new FakeDriver(),
        hub: new Hub(),
        scheduler: built.scheduler,
        workspaces: built.service,
        maxQueuedWorkspaces: 10,
        checkpointTransfers: service,
      });
      const operation = await store.getOperation(f.operationId);
      if (!operation) throw new Error("Recorded preserve operation missing.");
      await persistence.reconcileCheckpointOperation(operation);
      expect((await store.getOperation(f.operationId))?.state).toBe(committed ? "succeeded" : "failed");
      expect((await store.getWorkspace(f.workspaceId))?.state).toBe(committed ? "preserved" : "preserving");
      const storage = (await store.listWorkspaceStorage(f.workspaceId))[0];
      expect(storage?.state).toBe(committed ? "deleted" : "retained");
      expect(
        await store.getOperationByIdempotency(operation.principalId, "preserve", operation.idempotencyKey),
      ).toMatchObject({ id: operation.id, state: committed ? "succeeded" : "failed" });
      expect(await service.reconcile()).toBe(0);
      await built.scheduler.drain();
    } finally {
      await service.close();
      await store.close();
      await rm(f.dataDir, { recursive: true, force: true });
      await rm(dirname(f.directory), { recursive: true, force: true });
    }
  },
);

test("restart keeps a moved publication inode charged until owned removal", async () => {
  const f = await crash("rename");
  const store = await PGliteStore.create(f.dataDir);
  const service = transfers(store, f.directory);
  const path = join(f.directory, `${f.checkpointId}-${f.transferId}.tar`);
  const moved = join(f.directory, "moved-owned-publication");
  try {
    await rename(path, moved);
    const bytes = await readFile(moved);
    expect(await service.reconcile()).toBe(1);
    const row = await store.checkpointTransfers.get(f.transferId);
    expect(row?.state).toBe("publishing");
    expect((await store.storageReservations.get(row?.reservationId ?? ""))?.state).toBe("reserved");
    expect(await readFile(moved)).toEqual(bytes);
    await rename(moved, path);
    expect(await service.reconcile()).toBe(0);
    expect((await store.storageReservations.get(row?.reservationId ?? ""))?.state).toBe("released");
  } finally {
    await service.close();
    await store.close();
    await rm(f.dataDir, { recursive: true, force: true });
    await rm(dirname(f.directory), { recursive: true, force: true });
  }
});
