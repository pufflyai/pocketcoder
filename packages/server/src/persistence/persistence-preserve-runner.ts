import { isAgentApiNative, parseDurationMs } from "@pstdio/pocketcoder-contracts";
import type {
  StorageRef,
  WorkspaceCheckpointRow,
  WorkspaceRow,
  WorkspaceStorageRow,
} from "@pstdio/pocketcoder-runtime-core";
import type { PersistenceContext, SnapshotResult } from "./persistence-base";

export class PersistencePreserveRunner {
  constructor(private readonly context: PersistenceContext) {}
  async stopForSnapshot(workspace: WorkspaceRow, operationId: string): Promise<boolean> {
    const spec = workspace.templateSnapshot.spec;
    const native = isAgentApiNative(spec);
    const hook = native ? undefined : spec.checkpointHook;
    const deadlineMs = native ? parseDurationMs(spec.timeouts.terminateGrace) : (hook?.timeoutSeconds ?? 0) * 1000;
    const quiesced =
      native || hook ? await this.context.deps.hub.prepareCheckpoint(workspace.id, operationId, deadlineMs) : false;
    if (!workspace.providerRef) return quiesced;
    await this.context.deps.driver.stop(
      {
        kind: workspace.providerKind ?? "",
        id: "",
        ...workspace.providerRef,
      },
      Math.max(1, Math.ceil(parseDurationMs(workspace.templateSnapshot.spec.timeouts.terminateGrace) / 1000)),
    );
    return quiesced;
  }

  async createSnapshot(
    workspace: WorkspaceRow,
    checkpoint: WorkspaceCheckpointRow,
    storage: WorkspaceStorageRow,
  ): Promise<SnapshotResult> {
    const storageDriver = this.context.storageDriver();
    await this.context.deps.store.updateWorkspaceStorage(storage.id, { state: "snapshotting" }, this.context.now());
    const result = await storageDriver.snapshot(
      storage.providerRef as StorageRef,
      checkpoint.id,
      workspace.templateDigest,
      storage.mountManifest,
    );
    await storageDriver.verifyCheckpoint(result.ref, result.manifest);
    await this.context.assertMeasuredCheckpoint(
      workspace.principalId,
      result.manifest.logical_bytes,
      result.manifest.file_count,
    );
    return result;
  }

  async completePreserve(
    workspace: WorkspaceRow,
    checkpoint: WorkspaceCheckpointRow,
    storage: WorkspaceStorageRow,
    operationId: string,
    result: SnapshotResult,
    quiesced: boolean,
  ): Promise<void> {
    const { store, driver, hub } = this.context.deps;
    const readyAt = this.context.now();
    const conversationRestore = quiesced ? workspace.persistenceCapability : "filesystem_only";
    await store.updateCheckpoint(
      checkpoint.id,
      {
        state: "ready",
        providerKind: this.context.storageDriver().kind,
        providerRef: result.ref,
        manifest: result.manifest,
        manifestDigest: result.manifestDigest,
        logicalBytes: result.manifest.logical_bytes,
        storedBytes: result.storedBytes,
        fileCount: result.manifest.file_count,
        conversationRestore,
        readyAt,
      },
      readyAt,
    );
    const readyCheckpoint = await store.getCheckpoint(checkpoint.id);
    if (readyCheckpoint) await this.context.emitCheckpointEvent("checkpoint.ready", readyCheckpoint);
    await store.updateWorkspaceStorage(
      storage.id,
      {
        state: "retained",
        logicalBytes: result.manifest.logical_bytes,
        fileCount: result.manifest.file_count,
        retainedUntil: checkpoint.expiresAt,
      },
      readyAt,
    );
    await store.updateWorkspace(
      workspace.id,
      { latestCheckpointId: checkpoint.id, persistenceCapability: conversationRestore },
      readyAt,
    );
    if (workspace.providerRef) {
      await driver.remove({
        kind: workspace.providerKind ?? "",
        id: "",
        ...workspace.providerRef,
      });
    }
    hub.close(workspace.id);
    await store.transition(workspace.id, {
      from: ["preserving"],
      to: "preserved",
      reason: "checkpoint_created",
      at: readyAt,
      patch: { latestCheckpointId: checkpoint.id },
    });
    await store.updateOperation(operationId, { state: "succeeded", completedAt: readyAt }, readyAt);
  }

  async handlePreserveFailure(
    error: unknown,
    workspace: WorkspaceRow,
    checkpoint: WorkspaceCheckpointRow,
    storage: WorkspaceStorageRow,
    operationId: string,
    stopped: boolean,
  ): Promise<void> {
    const { store, driver, hub } = this.context.deps;
    const at = this.context.now();
    const quota = error instanceof Error && error.message.includes("checkpoint.quota_exceeded");
    const reason = quota ? "checkpoint_quota_exceeded" : "checkpoint_failed";
    await store.updateCheckpoint(checkpoint.id, { state: "failed", reasonCode: reason }, at);
    const failedCheckpoint = await store.getCheckpoint(checkpoint.id);
    if (failedCheckpoint) {
      await this.context.emitCheckpointEvent("checkpoint.failed", failedCheckpoint);
    }
    await store.updateWorkspaceStorage(
      storage.id,
      {
        state: stopped ? "retained" : storage.state,
        lastErrorCode: reason,
      },
      at,
    );
    if (stopped && workspace.providerRef) {
      await driver
        .remove({
          kind: workspace.providerKind ?? "",
          id: "",
          ...workspace.providerRef,
        })
        .catch((removeError) => {
          this.context.deps.log?.(`preserve cleanup ${workspace.id}: ${String(removeError)}`);
        });
      hub.close(workspace.id);
    }
    await store.transition(workspace.id, {
      from: ["preserving"],
      to: "failed",
      reason,
      at,
    });
    await this.context.failOperation(operationId, reason);
  }

  async runPreserve(workspaceId: string, checkpointId: string, operationId: string): Promise<void> {
    const { store } = this.context.deps;
    await store.updateOperation(operationId, { state: "running", attemptCount: 1 }, this.context.now());
    const workspace = await store.getWorkspace(workspaceId);
    const checkpoint = await store.getCheckpoint(checkpointId);
    const storage = await store.getWorkspaceStorage(workspaceId);
    if (!workspace || !checkpoint || !storage) {
      await this.context.failOperation(operationId, "checkpoint_storage_lost");
      return;
    }
    let stopped = false;
    try {
      const quiesced = await this.stopForSnapshot(workspace, operationId);
      stopped = workspace.providerRef !== null;
      const result = await this.createSnapshot(workspace, checkpoint, storage);
      await this.completePreserve(workspace, checkpoint, storage, operationId, result, quiesced);
    } catch (error) {
      await this.handlePreserveFailure(error, workspace, checkpoint, storage, operationId, stopped);
      throw error;
    }
  }
}
