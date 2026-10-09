import {
  CHECKPOINT_TRANSFER_MIN_PROTOCOL_VERSION,
  type CheckpointPrepared,
  CheckpointPreparedPayload,
  type PrepareCheckpointArchive,
  type ServerFrame,
} from "@pstdio/pocketcoder-contracts";
import type { LiveConnection } from "./hub";

interface PendingArchive {
  payload: PrepareCheckpointArchive;
  resolve(value: { connection: LiveConnection; declaration: CheckpointPrepared } | null): void;
  timer: ReturnType<typeof setTimeout>;
}

export class CheckpointRegistry {
  private readonly pending = new Map<LiveConnection, PendingArchive>();
  constructor(
    private readonly current: (connection: LiveConnection) => boolean,
    private readonly send: (connection: LiveConnection, type: ServerFrame["type"], payload: unknown) => void,
  ) {}

  prepare(connection: LiveConnection | undefined, payload: PrepareCheckpointArchive) {
    if (
      !connection?.registered ||
      connection.protocolVersion < CHECKPOINT_TRANSFER_MIN_PROTOCOL_VERSION ||
      this.pending.has(connection)
    )
      return Promise.resolve(null);
    if (!Number.isSafeInteger(payload.deadline_ms) || payload.deadline_ms <= 0) return Promise.resolve(null);
    return new Promise<{ connection: LiveConnection; declaration: CheckpointPrepared } | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(connection);
        resolve(null);
      }, payload.deadline_ms);
      this.pending.set(connection, { payload, resolve, timer });
      try {
        this.send(connection, "prepare_checkpoint_archive", payload);
      } catch {
        this.drop(connection);
      }
    });
  }

  prepared(connection: LiveConnection, value: CheckpointPrepared) {
    const pending = this.pending.get(connection);
    if (!this.current(connection) || !pending) return;
    const parsed = CheckpointPreparedPayload.safeParse(value);
    if (!parsed.success) return;
    const declaration = parsed.data;
    if (
      declaration.operation_id !== pending.payload.operation_id ||
      declaration.checkpoint_id !== pending.payload.checkpoint_id ||
      declaration.header.workspace_id !== connection.workspaceId ||
      declaration.archive_bytes > pending.payload.max_archive_bytes
    )
      return;
    clearTimeout(pending.timer);
    this.pending.delete(connection);
    pending.resolve({ connection, declaration });
  }

  failed(connection: LiveConnection, operationId: string) {
    if (this.current(connection) && this.pending.get(connection)?.payload.operation_id === operationId)
      this.drop(connection);
  }

  drop(connection: LiveConnection) {
    const pending = this.pending.get(connection);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(connection);
    pending.resolve(null);
  }
}
