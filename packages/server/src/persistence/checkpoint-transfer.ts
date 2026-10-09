import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, statfsSync } from "node:fs";
import {
  CHECKPOINT_TRANSFER_MIN_PROTOCOL_VERSION,
  type CheckpointInstalled,
  type RestoreTransferSpec,
} from "@pstdio/pocketcoder-contracts";
import type { Store, WorkspaceCheckpointRow, WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
import type { Hub, LiveConnection } from "../control-channel/hub";
import { checkpointPreservationExpiry, checkpointTransferExpiry } from "./checkpoint-preservation-deadline";
import { type CheckpointRetentionLimits, createCheckpointTransferHttp } from "./checkpoint-transfer-http";
import { createTransferLifetime, type TransferRow } from "./checkpoint-transfer-lifetime";
import { createCheckpointTransferMaintenance } from "./checkpoint-transfer-maintenance";
import { createCheckpointTransferRecovery } from "./checkpoint-transfer-recovery";

export interface CheckpointTransferLimits {
  deadlineMs: number;
  maxArchiveBytes: number;
  maxIndexBytes: number;
  maxQueueBytes: number;
  maxLedgerBytes: number;
}
export interface CheckpointTransferOptions {
  store: Store;
  hub: Hub;
  directory: string;
  limits: CheckpointTransferLimits;
  retentionLimits: CheckpointRetentionLimits;
  readCapacity: Parameters<Store["checkpointTransfers"]["grantUpload"]>[1];
  agentBaseUrl: string | (() => string);
}

export function createCheckpointTransferService(options: CheckpointTransferOptions) {
  const { store, hub, limits, readCapacity } = options;
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const directory = realpathSync(options.directory);
  const lifetime = createTransferLifetime(store, hub);
  const http = createCheckpointTransferHttp(store, lifetime, directory, options.retentionLimits);
  function url(operationId: string) {
    const base = typeof options.agentBaseUrl === "function" ? options.agentBaseUrl() : options.agentBaseUrl;
    return new URL(`/v1/agent/checkpoints/${operationId}/archive`, base).toString();
  }
  function live(connection: LiveConnection, expiresAt: Date) {
    return () => {
      lifetime.ensureOpen();
      if (hub.get(connection.workspaceId) !== connection || !connection.registered || expiresAt <= new Date())
        throw new Error("Checkpoint connection authority changed.");
    };
  }
  function credential() {
    const value = randomBytes(32).toString("base64url");
    return { value, digest: createHash("sha256").update(value).digest() };
  }
  async function openGrant(connection: LiveConnection, row: TransferRow) {
    try {
      return lifetime.open(connection, row);
    } catch (error) {
      await store.checkpointTransfers.abort(row.id, () => {});
      throw error;
    }
  }
  const maintenance = createCheckpointTransferMaintenance(store, lifetime, directory);
  const service = {
    reconcile: createCheckpointTransferRecovery(store, lifetime, directory, maintenance.verify),
    ...http,
    ...maintenance,
    async preserve(workspace: WorkspaceRow, checkpoint: WorkspaceCheckpointRow, operationId: string) {
      const expiresAt = await checkpointPreservationExpiry(
        store,
        workspace,
        checkpoint,
        operationId,
        limits.deadlineMs,
      );
      const prepared = await lifetime.prepare(workspace.id, {
        operation_id: operationId,
        checkpoint_id: checkpoint.id,
        deadline_ms: Math.max(1, expiresAt.getTime() - Date.now()),
        mounts: workspace.templateSnapshot.spec.persistence.mounts,
        max_archive_bytes: limits.maxArchiveBytes,
        max_index_bytes: limits.maxIndexBytes,
        max_queue_bytes: limits.maxQueueBytes,
      });
      if (!prepared) throw new Error("Checkpoint archive preparation failed.");
      const { connection, declaration } = prepared;
      const check = live(connection, expiresAt);
      check();
      const secret = credential();
      const block = statfsSync(directory).bsize;
      // Spool and copy each hold wire bytes; the two index files share a wire-sized budget.
      const reservedBytes = 3 * Math.ceil(declaration.archive_bytes / block) * block + block;
      if (!Number.isSafeInteger(reservedBytes)) throw new Error("Checkpoint measured reservation is too large.");
      const row = await store.checkpointTransfers.grantUpload(
        {
          id: randomUUID(),
          operationId,
          checkpointId: checkpoint.id,
          workspaceId: workspace.id,
          connectionEpoch: connection.epoch,
          header: declaration.header,
          expectedArchiveBytes: declaration.archive_bytes,
          grantDigest: secret.digest,
          expiresAt,
          reservationId: randomUUID(),
          reservedBytes,
          reservedFiles: 5,
          retentionLimits: options.retentionLimits,
        },
        readCapacity,
        check,
      );
      const context = await openGrant(connection, row);
      try {
        context.check();
        hub.send(connection, "checkpoint_upload", {
          operation_id: operationId,
          checkpoint_id: checkpoint.id,
          transfer_id: row.id,
          credential: secret.value,
          url: url(operationId),
          expires_at: expiresAt.toISOString(),
        });
        await context.publication;
        const ready = await store.getCheckpoint(checkpoint.id);
        if (ready?.state !== "ready") throw new Error("Checkpoint durable publication is unavailable.");
        return ready;
      } catch (error) {
        await lifetime.cleanup(context, error);
        throw error;
      }
    },
    async restoreGrant(connection: LiveConnection, workspace: WorkspaceRow): Promise<RestoreTransferSpec | null> {
      if (
        workspace.launchMode !== "restore" ||
        !workspace.restoredFromCheckpointId ||
        connection.protocolVersion < CHECKPOINT_TRANSFER_MIN_PROTOCOL_VERSION
      )
        return null;
      const checkpoint = await store.getCheckpoint(workspace.restoredFromCheckpointId);
      if (checkpoint?.providerKind !== "controller-archive") return null;
      const operation = (await store.listIncompleteOperations()).find(
        (row) => row.kind === "restore" && row.resultWorkspaceId === workspace.id && row.checkpointId === checkpoint.id,
      );
      if (!operation) return null;
      const expiresAt = checkpointTransferExpiry(workspace, limits.deadlineMs);
      const check = live(connection, expiresAt);
      const secret = credential();
      const row = await store.checkpointTransfers.grantDownload(
        {
          id: randomUUID(),
          operationId: operation.id,
          checkpointId: checkpoint.id,
          workspaceId: workspace.id,
          connectionEpoch: connection.epoch,
          grantDigest: secret.digest,
          expiresAt,
        },
        check,
      );
      const context = await openGrant(connection, row);
      try {
        context.check();
        if (!row.declaredHeader || !row.archiveDigest || !row.storedBytes)
          throw new Error("Restore publication receipt is missing.");
        return {
          operation_id: operation.id,
          checkpoint_id: checkpoint.id,
          transfer_id: row.id,
          credential: secret.value,
          url: url(operation.id),
          expires_at: expiresAt.toISOString(),
          source: {
            checkpoint_id: checkpoint.id,
            workspace_id: checkpoint.workspaceId,
            template_digest: checkpoint.templateDigest,
            archive_digest: row.archiveDigest,
          },
          mounts: workspace.templateSnapshot.spec.persistence.mounts,
          max_archive_bytes: row.storedBytes,
          max_index_bytes: row.storedBytes,
          max_ledger_bytes: limits.maxLedgerBytes,
        };
      } catch (error) {
        await lifetime.cleanup(context, error);
        throw error;
      }
    },
    async installed(connection: LiveConnection, payload: CheckpointInstalled) {
      const context = lifetime.active.get(payload.transfer_id);
      if (
        !context ||
        context.connection !== connection ||
        context.row.direction !== "download" ||
        context.row.operationId !== payload.operation_id ||
        context.row.checkpointId !== payload.checkpoint_id ||
        context.row.archiveDigest !== payload.archive_digest
      )
        return false;
      if (payload.phase === "failed") {
        await lifetime.cleanup(context);
        return false;
      }
      try {
        context.check();
        await context.validate();
        await store.checkpointTransfers.installed(context.row.id, context.check);
        context.published();
        return true;
      } catch (error) {
        await lifetime.cleanup(context, error);
        return false;
      }
    },
    async ready(connection: LiveConnection) {
      const check = () => {
        lifetime.ensureOpen();
        assertRestoreReady(hub, connection);
      };
      check();
      return store.checkpointTransfers.completeRestore(connection.workspaceId, connection.epoch, check);
    },
    cleanup: lifetime.cleanupWorkspace,
    disconnected(connection: LiveConnection) {
      return lifetime.cleanupWorkspace(connection.workspaceId, connection);
    },
    drain: lifetime.drain,
    close: lifetime.drain,
  };
  return {
    ...service,
    preserve: (...args: Parameters<typeof service.preserve>) =>
      lifetime.run(args[0].id, () => service.preserve(...args)),
    restoreGrant: (...args: Parameters<typeof service.restoreGrant>) =>
      lifetime.run(args[0].workspaceId, () => service.restoreGrant(...args)),
    ready: (...args: Parameters<typeof service.ready>) =>
      lifetime.run(args[0].workspaceId, () => service.ready(...args)),
    installed: (...args: Parameters<typeof service.installed>) =>
      lifetime.run(args[0].workspaceId, () => service.installed(...args)),
    verify: (...args: Parameters<typeof service.verify>) =>
      lifetime.run(args[0].workspaceId, () => service.verify(...args)),
    delete: (...args: Parameters<typeof service.delete>) =>
      lifetime.run(args[0].workspaceId, () => service.delete(...args)),
  };
}
export type CheckpointTransferService = ReturnType<typeof createCheckpointTransferService>;

function assertRestoreReady(hub: Hub, connection: LiveConnection) {
  if (
    hub.get(connection.workspaceId) !== connection ||
    !connection.registered ||
    !connection.restoreInstalled ||
    !connection.harnessRunning
  )
    throw new Error("Restore ready connection changed.");
}
