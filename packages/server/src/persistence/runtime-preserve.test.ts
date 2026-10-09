import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerDriver, FilesystemStorageDriver } from "@pstdio/pocketcoder-drivers";
import { DEFAULT_LIMITS, reconcilePersistence } from "@pstdio/pocketcoder-runtime-core";
import { buildServer } from "../app";
import { createIssuerClient } from "../secrets/issuer-client";
import { leaseServiceFixture } from "../secrets/lease-service-fixture";

test.each(["preserve", "cancel"] as const)(
  "issuer outage cleanup followed by %s",
  async (action) => {
    const cancel = action === "cancel";
    const f = await leaseServiceFixture("disk", undefined, undefined, true);
    const directory = await mkdtemp(join(tmpdir(), "pc-runtime-preserve-"));
    let built: ReturnType<typeof buildServer> | undefined;
    try {
      await f.store.updatePrincipal(f.principal.id, ["admin"], ["*"]);
      const principal = (await f.store.listPrincipals()).find((row) => row.id === f.principal.id);
      if (!principal) throw new Error("Missing principal");
      await f.vault.put(f.key.id, "runtime", { ...f.config, type: "runtime-issuer" });
      const initial = await f.service.issue(f.workspace.id, "runtime", "runtime-issuer");
      await f.store.transition(f.workspace.id, { from: ["provisioning"], to: "connected", at: new Date() });
      const driver = new DockerDriver({ inputDir: join(directory, "inputs") });
      const storageDriver = new FilesystemStorageDriver({
        workspaceRoot: join(directory, "workspaces"),
        checkpointRoot: join(directory, "archives"),
      });
      const storageId = randomUUID();
      const mounts = f.workspace.templateSnapshot.spec.persistence.mounts;
      const allocated = await storageDriver.allocate({
        storageId,
        workspaceId: f.workspace.id,
        mounts,
        uid: process.getuid?.() ?? 0,
        gid: process.getgid?.() ?? 0,
      });
      const at = new Date();
      await f.store.insertWorkspaceStorage({
        id: storageId,
        workspaceId: f.workspace.id,
        principalId: principal.id,
        providerKind: "filesystem",
        providerRef: allocated.ref,
        state: "ready",
        mountManifest: mounts,
        logicalBytes: null,
        fileCount: null,
        retainedUntil: null,
        createdAt: at,
        updatedAt: at,
        deletedAt: null,
        lastErrorCode: null,
      });
      built = buildServer({
        store: f.store,
        driver,
        storageDriver,
        pepper: f.pepper,
        secretKey: f.encryptionKey.toString("base64url"),
        issuerClient: createIssuerClient({ ca: f.issuer.ca }),
        limits: DEFAULT_LIMITS,
        workspaceServerUrl: "http://127.0.0.1",
        checkpointTransferOptions: {
          directory: join(directory, "archives"),
          agentBaseUrl: "http://127.0.0.1",
          limits: {
            deadlineMs: 3000,
            maxArchiveBytes: 65536,
            maxIndexBytes: 65536,
            maxQueueBytes: 65536,
            maxLedgerBytes: 65536,
          },
          retentionLimits: {
            maxCheckpointFiles: 1000,
            maxRetainedBytes: 1_000_000,
            maxRetainedBytesPerPrincipal: 1_000_000,
            maxCheckpointsPerPrincipal: 10,
          },
          readCapacity: () => ({
            workspace: { bytes: 1_000_000, files: 1000 },
            principal: { bytes: 1_000_000, files: 1000 },
            instance: { bytes: 1_000_000, files: 1000 },
            freeDisk: { bytes: 10_000_000, files: 10_000, headroomBytes: 0, headroomFiles: 0 },
          }),
        },
      });
      f.issuer.controls.reply = "outage";
      const preserved = await built.persistence.preserve(principal, f.workspace.id, {}, randomUUID());
      await built.persistence.drain();
      expect(await f.store.getOperation(preserved.operation.id)).toMatchObject({ state: "pending", completedAt: null });
      expect((await f.store.getCheckpoint(preserved.checkpoint.id))?.state).toBe("creating");
      expect((await f.store.getWorkspaceStorage(f.workspace.id))?.state).toBe("ready");
      expect(await f.issuer.resource(initial.credential, f.workspace.id)).toBe(200);
      await reconcilePersistence({ store: f.store, driver, storageDriver });
      expect((await f.store.getOperation(preserved.operation.id))?.state).toBe("pending");
      if (cancel) {
        await built.service.cancel(principal, f.workspace.id);
        await built.scheduler.drain();
        expect((await f.store.getWorkspace(f.workspace.id))?.state).toBe("terminating");
        await built.persistence.retryPreserves();
        await built.persistence.drain();
        expect((await f.store.getOperation(preserved.operation.id))?.state).toBe("pending");
        await reconcilePersistence({ store: f.store, driver, storageDriver });
        expect((await f.store.getOperation(preserved.operation.id))?.state).toBe("pending");
      }
      f.issuer.controls.reply = "valid";
      await f.service.revokeWorkspace(f.workspace.id);
      if (cancel) {
        const current = await f.store.getWorkspace(f.workspace.id);
        if (!current) throw new Error("Missing workspace");
        await built.scheduler.finalize(current, "canceled", "canceled_by_caller", new Date());
      }
      if (!cancel) {
        await reconcilePersistence({ store: f.store, driver, storageDriver });
        expect((await f.store.getOperation(preserved.operation.id))?.state).toBe("pending");
      }
      await built.persistence.retryPreserves();
      await built.persistence.drain();
      // No agent is connected: capture now fails and retains the recoverable source.
      expect((await f.store.getOperation(preserved.operation.id))?.state).toBe("failed");
      expect((await f.store.getCheckpoint(preserved.checkpoint.id))?.state).toBe("failed");
      if (!cancel) expect((await f.store.getWorkspaceStorage(f.workspace.id))?.state).toBe("retained");
      expect(await f.issuer.resource(initial.credential, f.workspace.id)).toBe(401);
      expect(await f.store.listPendingWorkspaceLeases(f.workspace.id)).toEqual([]);
      if (cancel) {
        expect((await f.store.getWorkspace(f.workspace.id))?.state).toBe("canceled");
        const purge = await built.persistence.purge(principal, f.workspace.id, randomUUID());
        await built.persistence.drain();
        expect((await f.store.getOperation(purge.id))?.state).toBe("succeeded");
      }
    } finally {
      f.issuer.controls.reply = "valid";
      await built?.checkpointTransfers?.close();
      await built?.persistence.drain();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  20_000,
);

test("restart fails an unadmitted preserve without stopping the active workspace", async () => {
  const f = await leaseServiceFixture("disk", undefined, undefined, true);
  const directory = await mkdtemp(join(tmpdir(), "pc-preserve-admission-"));
  try {
    await f.vault.put(f.key.id, "runtime", { ...f.config, type: "runtime-issuer" });
    const initial = await f.service.issue(f.workspace.id, "runtime", "runtime-issuer");
    await f.store.transition(f.workspace.id, { from: ["provisioning"], to: "connected", at: new Date() });
    const driver = new DockerDriver({ inputDir: join(directory, "inputs") });
    const storageDriver = new FilesystemStorageDriver({
      workspaceRoot: join(directory, "workspaces"),
      checkpointRoot: join(directory, "archives"),
    });
    const storageId = randomUUID();
    const mounts = f.workspace.templateSnapshot.spec.persistence.mounts;
    const allocated = await storageDriver.allocate({
      storageId,
      workspaceId: f.workspace.id,
      mounts,
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
    });
    const at = new Date();
    await f.store.insertWorkspaceStorage({
      id: storageId,
      workspaceId: f.workspace.id,
      principalId: f.principal.id,
      providerKind: "filesystem",
      providerRef: allocated.ref,
      state: "ready",
      mountManifest: mounts,
      logicalBytes: null,
      fileCount: null,
      retainedUntil: null,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
      lastErrorCode: null,
    });
    const operationId = randomUUID();
    const checkpointId = randomUUID();
    await f.store.insertOperation({
      id: operationId,
      principalId: f.principal.id,
      kind: "preserve",
      state: "pending",
      idempotencyKey: randomUUID(),
      requestDigest: randomUUID(),
      workspaceId: f.workspace.id,
      checkpointId: null,
      resultWorkspaceId: null,
      reasonCode: null,
      attemptCount: 0,
      createdAt: at,
      updatedAt: at,
      completedAt: null,
    });
    await f.store.insertCheckpoint({
      id: checkpointId,
      workspaceId: f.workspace.id,
      principalId: f.principal.id,
      storageId,
      parentCheckpointId: null,
      state: "creating",
      reasonCode: null,
      providerKind: "controller-archive",
      providerRef: null,
      templateSnapshot: f.workspace.templateSnapshot,
      templateDigest: f.workspace.templateDigest,
      sourceProvenance: null,
      manifest: null,
      manifestDigest: null,
      logicalBytes: null,
      storedBytes: null,
      fileCount: null,
      conversationRestore: "filesystem_only",
      label: null,
      createdAt: at,
      updatedAt: at,
      readyAt: null,
      expiresAt: new Date(at.getTime() + 60000),
      deletedAt: null,
    });
    await f.store.updateOperation(operationId, { checkpointId }, at);
    await reconcilePersistence({ store: f.store, driver, storageDriver });
    expect((await f.store.getOperation(operationId))?.state).toBe("failed");
    expect((await f.store.getCheckpoint(checkpointId))?.state).toBe("failed");
    expect((await f.store.getWorkspace(f.workspace.id))?.state).toBe("connected");
    expect((await f.store.getWorkspaceStorage(f.workspace.id))?.state).toBe("ready");
    expect((await f.store.getWorkspaceLease(initial.lease.id))?.state).toBe("delivered");
    expect(await f.issuer.resource(initial.credential, f.workspace.id)).toBe(200);
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
