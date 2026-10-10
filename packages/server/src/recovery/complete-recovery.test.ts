import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGliteStore } from "@pstdio/pocketcoder-db";
import { restoreBackup } from "@pstdio/pocketcoder-db/backup";
import { insertTestWorkspace } from "@pstdio/pocketcoder-db/testing";
import { DockerDriver, FilesystemStorageDriver } from "@pstdio/pocketcoder-drivers";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { eq } from "drizzle-orm";
import { buildServer } from "../app";
import { checkpointHttpFixture } from "../persistence/checkpoint-transfer-fixture.test";
import { completeRecovery } from "./complete-recovery";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

// A backup holding one running workspace and its published checkpoint archive.
async function backedUp() {
  const f = await checkpointHttpFixture(new TextEncoder().encode("restored bytes"));
  cleanup.push(f.dispose);
  const out = await realpath(await mkdtemp(join(tmpdir(), "pc-recovery-out-")));
  cleanup.push(() => rm(out, { recursive: true, force: true }));
  const pending = f.service.preserve(f.workspace, f.checkpoint, f.operationId);
  const grant = await f.grant;
  expect((await fetch(grant.url, { method: "PUT", headers: f.headers(grant), body: f.raw })).status).toBe(201);
  const checkpoint = await pending;
  // The backup barrier lets preserves finish first; this workspace keeps running afterwards.
  const { tables, db } = f.context;
  await db
    .update(tables.workspaceStorage)
    .set({ providerRef: { kind: "tmpfs", id: checkpoint.storageId } })
    .where(eq(tables.workspaceStorage.id, checkpoint.storageId));
  await f.store.updateOperation(f.operationId, { state: "succeeded", completedAt: new Date() }, new Date());
  await db.update(tables.workspaces).set({ state: "ready" }).where(eq(tables.workspaces.id, f.workspace.id));
  const second = await insertTestWorkspace(f, "second");
  const archive = join(out, "controller.tar");
  await f.store.backup({
    output: archive,
    checkpointDirectory: f.directory,
    keys: { "auth-pepper": randomBytes(32), "event-signing-key": randomBytes(32), "secret-key": randomBytes(32) },
    signal: new AbortController().signal,
    freeze: (capture) => capture(() => {}),
  });
  return { f, out, archive, second };
}

// Docker that fails its first listing, like an outage during the first recovery attempt.
class FlakyDocker extends DockerDriver {
  failures = 1;
  override async list() {
    if (this.failures-- > 0) throw new Error("Docker is unavailable.");
    return super.list();
  }
}

async function restored(out: string, archive: string, driver = new DockerDriver({ inputDir: join(out, "inputs") })) {
  const checkpoints = join(out, "checkpoints");
  const { directory } = await restoreBackup({ archive, dataDir: join(out, "restored"), checkpointDir: checkpoints });
  const store = await PGliteStore.create(directory);
  cleanup.push(() => store.close());
  const storageDriver = new FilesystemStorageDriver({
    workspaceRoot: join(out, "live"),
    checkpointRoot: join(out, "legacy"),
  });
  const runtime = buildServer({
    store,
    driver,
    storageDriver,
    pepper: "recovery-test",
    limits: DEFAULT_LIMITS,
    workspaceServerUrl: "http://127.0.0.1:8090",
    checkpointTransferOptions: {
      directory: checkpoints,
      agentBaseUrl: "http://127.0.0.1:8091",
      retentionLimits: {
        maxCheckpointFiles: 100,
        maxRetainedBytes: 1_000_000,
        maxRetainedBytesPerPrincipal: 1_000_000,
        maxCheckpointsPerPrincipal: 10,
      },
      limits: {
        deadlineMs: 3000,
        maxArchiveBytes: 65536,
        maxIndexBytes: 65536,
        maxQueueBytes: 65536,
        maxLedgerBytes: 65536,
      },
      readCapacity: () => ({
        workspace: { bytes: 1_000_000, files: 100 },
        principal: { bytes: 1_000_000, files: 100 },
        instance: { bytes: 1_000_000, files: 100 },
        freeDisk: { bytes: 2_000_000, files: 200, headroomBytes: 1_000_000, headroomFiles: 100 },
      }),
    },
  });
  cleanup.push(async () => {
    await runtime.checkpointTransfers?.close();
    await runtime.scheduler.drain();
  });
  return { store, driver, storageDriver, runtime, checkpoints };
}

test("an interrupted recovery repeats every purge the backup missed and removes restored archives", async () => {
  const { f, out, archive, second } = await backedUp();
  // The old controller admitted these purges after the backup; their journal records are all that remain.
  for (const workspaceId of [f.workspace.id, second.id])
    f.context.journal?.append({
      kind: "workspace_purged",
      principalId: f.workspace.principalId,
      workspaceId,
      at: new Date().toISOString(),
    });
  await f.store.close();

  const flaky = new FlakyDocker({ inputDir: join(out, "inputs") });
  const { store, storageDriver, runtime, checkpoints } = await restored(out, archive, flaky);
  expect(await readdir(checkpoints)).toHaveLength(1);
  await expect(completeRecovery({ store, driver: flaky, storageDriver }, runtime)).rejects.toThrow("Retry recovery");
  expect(await store.recovery.recoveryState()).not.toBeNull();

  const result = await completeRecovery({ store, driver: flaky, storageDriver }, runtime);
  expect(await readdir(checkpoints)).toEqual([]);
  for (const id of [f.workspace.id, second.id]) expect((await store.getWorkspace(id))?.purgeRequestedAt).not.toBeNull();
  expect(await store.listNonterminal()).toEqual([]);
  expect(await store.recovery.recoveryState()).toBeNull();
  expect(result.events).toBeGreaterThan(1);
}, 60_000);

test("recovery fences a runtime the backup still lists as active and keeps its checkpoint", async () => {
  const { f, out, archive } = await backedUp();
  await f.store.close();

  const { store, driver, storageDriver, runtime, checkpoints } = await restored(out, archive);
  const result = await completeRecovery({ store, driver, storageDriver }, runtime);

  expect(result.workspaces).toBe(2);
  expect((await store.getWorkspace(f.workspace.id))?.state).toBe("failed");
  expect(await readdir(checkpoints)).toHaveLength(1);
  expect((await store.getCheckpoint(f.checkpoint.id))?.state).toBe("ready");
  expect(await store.recovery.recoveryState()).toBeNull();
}, 60_000);
