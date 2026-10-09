import { mkdtemp, realpath, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentFrame,
  CHECKPOINT_ARCHIVE_FORMAT,
  type CheckpointUpload,
  type ExecSpec,
  type PrepareCheckpointArchive,
  type RestoreTransferSpec,
} from "@pstdio/pocketcoder-contracts";
import { createFilesystemCheckpointDownload } from "../checkpoints/filesystem-download";
import { prepareFilesystemCheckpointUpload } from "../checkpoints/filesystem-upload";
import { checkpointRequest, type TransferConnection } from "./checkpoint-http";

interface TransferCallbacks {
  connection(): TransferConnection;
  send(type: AgentFrame["type"], payload: unknown): boolean;
  quiesce(operationId: string, deadlineMs: number, signal: AbortSignal): Promise<boolean>;
}
interface ActiveTransfer {
  operationId: string;
  checkpointId: string;
  abort: AbortController;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  scratch?: string;
  prepared?: Awaited<ReturnType<typeof prepareFilesystemCheckpointUpload>>;
  task?: Promise<unknown>;
  closing?: Promise<void>;
  uploading?: boolean;
}

export class SupervisorTransfers {
  private active: ActiveTransfer | undefined;
  constructor(
    private readonly serverUrl: string,
    private readonly templateDigest: string,
    private readonly callbacks: TransferCallbacks,
  ) {}

  async prepare(payload: PrepareCheckpointArchive, exec: ExecSpec) {
    if (this.active) throw new Error("Checkpoint transfer is already active.");
    const active = this.begin(payload.operation_id, payload.checkpoint_id, Date.now() + payload.deadline_ms);
    const task = (async () => {
      try {
        if (!(await this.callbacks.quiesce(payload.operation_id, payload.deadline_ms, active.abort.signal)))
          throw new Error("Checkpoint quiescence failed.");
        this.check(active);
        this.validateMounts(exec, payload.mounts);
        active.scratch = await realpath(await mkdtemp(join(tmpdir(), "pocketcoder-transfer-")));
        this.check(active);
        active.prepared = await prepareFilesystemCheckpointUpload(
          {
            format: CHECKPOINT_ARCHIVE_FORMAT,
            checkpoint_id: payload.checkpoint_id,
            workspace_id: this.callbacks.connection().workspaceId,
            template_digest: this.templateDigest,
          },
          payload.mounts.map((policy) => ({ root: policy.target, policy })),
          {
            directory: active.scratch,
            maxIndexBytes: payload.max_index_bytes,
            maxQueueBytes: payload.max_queue_bytes,
            maxArchiveBytes: payload.max_archive_bytes,
            signal: active.abort.signal,
            check: () => this.check(active),
          },
        );
        this.check(active);
        if (
          !this.callbacks.send("checkpoint_prepared", {
            operation_id: payload.operation_id,
            checkpoint_id: payload.checkpoint_id,
            header: active.prepared.header,
            archive_bytes: active.prepared.archiveBytes,
          })
        )
          throw new Error("Checkpoint connection closed.");
      } catch {
        this.callbacks.send("checkpoint_status", { operation_id: payload.operation_id, phase: "failed" });
        await this.release(active);
      }
    })();
    active.task = task;
    await task;
  }

  async upload(grant: CheckpointUpload) {
    const active = this.active;
    if (!active || active.operationId !== grant.operation_id || active.checkpointId !== grant.checkpoint_id) return;
    if (active.uploading) return;
    active.uploading = true;
    await active.task;
    if (!active.prepared || this.active !== active) return;
    this.expire(active, Math.min(active.deadline, Date.parse(grant.expires_at)));
    const task = (async () => {
      let body: ReadableStream<Uint8Array> | undefined;
      try {
        this.check(active);
        const request = checkpointRequest(this.serverUrl, grant, this.callbacks.connection(), active.abort.signal);
        body = active.prepared?.upload();
        const response = await fetch(request.url, {
          method: "PUT",
          headers: {
            ...request.headers,
            "content-type": "application/x-tar",
            "content-length": String(active.prepared?.archiveBytes),
          },
          body,
          signal: active.abort.signal,
          redirect: "error",
        });
        await response.body?.cancel();
        this.check(active);
        if (!response.ok) throw new Error("Checkpoint upload refused.");
        this.callbacks.send("checkpoint_upload_status", {
          operation_id: grant.operation_id,
          transfer_id: grant.transfer_id,
          checkpoint_id: grant.checkpoint_id,
          phase: "uploaded",
        });
      } catch {
        active.abort.abort(new Error("Checkpoint upload failed."));
        try {
          await body?.cancel();
        } catch {
          /* Fetch owns an already locked body. */
        }
        this.callbacks.send("checkpoint_upload_status", {
          operation_id: grant.operation_id,
          transfer_id: grant.transfer_id,
          checkpoint_id: grant.checkpoint_id,
          phase: "failed",
        });
      } finally {
        grant.credential = "";
        await this.release(active);
      }
    })();
    active.task = task;
    await task;
  }

  async restore(grant: RestoreTransferSpec, exec: ExecSpec) {
    if (this.active) throw new Error("Checkpoint transfer is already active.");
    const active = this.begin(grant.operation_id, grant.checkpoint_id, Date.parse(grant.expires_at));
    const task = (async () => {
      let download: Awaited<ReturnType<typeof createFilesystemCheckpointDownload>> | undefined;
      try {
        this.validateMounts(exec, grant.mounts);
        const connection = this.callbacks.connection();
        const request = checkpointRequest(this.serverUrl, grant, connection, active.abort.signal);
        active.scratch = await realpath(await mkdtemp(join(tmpdir(), "pocketcoder-transfer-")));
        const response = await fetch(request.url, {
          headers: request.headers,
          signal: active.abort.signal,
          redirect: "error",
        });
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new Error("Checkpoint download refused.");
        }
        download = await createFilesystemCheckpointDownload(
          response.body,
          {
            source: {
              checkpointId: grant.source.checkpoint_id,
              workspaceId: grant.source.workspace_id,
              templateDigest: grant.source.template_digest,
              archiveDigest: grant.source.archive_digest,
            },
            destination: { workspaceId: connection.workspaceId, operationId: grant.operation_id },
          },
          grant.mounts.map((policy) => ({ parent: policy.target, policy })),
          {
            directory: active.scratch,
            maxArchiveBytes: grant.max_archive_bytes,
            maxIndexBytes: grant.max_index_bytes,
            maxLedgerBytes: grant.max_ledger_bytes,
            signal: active.abort.signal,
            check: () => this.check(active),
          },
        );
        this.check(active);
        await download.publish();
        this.check(active);
        await download.close();
        this.check(active);
        download = undefined;
        if (
          !this.callbacks.send("checkpoint_installed", {
            operation_id: grant.operation_id,
            transfer_id: grant.transfer_id,
            checkpoint_id: grant.checkpoint_id,
            archive_digest: grant.source.archive_digest,
            phase: "installed",
          })
        )
          throw new Error("Checkpoint connection closed.");
      } catch (error) {
        this.callbacks.send("checkpoint_installed", {
          operation_id: grant.operation_id,
          transfer_id: grant.transfer_id,
          checkpoint_id: grant.checkpoint_id,
          archive_digest: grant.source.archive_digest,
          phase: "failed",
        });
        throw error;
      } finally {
        grant.credential = "";
        await download?.close();
        await this.release(active);
      }
    })();
    active.task = task;
    await task;
  }

  async cancel() {
    const active = this.active;
    if (!active) return;
    active.abort.abort(new Error("Checkpoint connection ended."));
    await active.task?.catch(() => {});
    await this.release(active);
  }

  private begin(operationId: string, checkpointId: string, deadline: number) {
    if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new Error("Checkpoint deadline has expired.");
    const active: ActiveTransfer = {
      operationId,
      checkpointId,
      deadline,
      abort: new AbortController(),
      timer: setTimeout(() => {}, 0),
    };
    this.active = active;
    this.expire(active, deadline);
    return active;
  }
  private expire(active: ActiveTransfer, deadline: number) {
    clearTimeout(active.timer);
    active.deadline = deadline;
    if (!Number.isFinite(deadline) || deadline <= Date.now())
      active.abort.abort(new Error("Checkpoint grant expired."));
    active.timer = setTimeout(
      () => {
        active.abort.abort(new Error("Checkpoint deadline exceeded."));
        void this.cancel().catch(() => {
          this.callbacks.send("checkpoint_status", { operation_id: active.operationId, phase: "failed" });
        });
      },
      Math.max(0, Math.min(2_147_483_647, deadline - Date.now())),
    );
  }
  private check(active: ActiveTransfer) {
    active.abort.signal.throwIfAborted();
    if (this.active !== active || Date.now() >= active.deadline) throw new Error("Checkpoint authority ended.");
  }
  private validateMounts(exec: ExecSpec, mounts: PrepareCheckpointArchive["mounts"]) {
    if (
      mounts.length !== exec.persistence.mounts.length ||
      mounts.some(
        (mount, index) =>
          mount.name !== exec.persistence.mounts[index]?.name ||
          mount.target !== exec.persistence.mounts[index]?.target,
      )
    )
      throw new Error("Checkpoint mounts differ from the registered template.");
  }
  private release(active: ActiveTransfer) {
    active.closing ??= (async () => {
      clearTimeout(active.timer);
      await active.prepared?.close();
      // Capture files are anonymous. A named member belongs to someone else.
      if (active.scratch) await rmdir(active.scratch);
      active.prepared = undefined;
      active.scratch = undefined;
      if (this.active === active) this.active = undefined;
    })();
    return active.closing;
  }
}
