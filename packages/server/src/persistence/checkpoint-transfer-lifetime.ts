import type { PrepareCheckpointArchive } from "@pstdio/pocketcoder-contracts";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import type { Hub, LiveConnection } from "../control-channel/hub";

export type TransferRow = NonNullable<Awaited<ReturnType<Store["checkpointTransfers"]["get"]>>>;
export interface ActiveCheckpointTransfer {
  connection: LiveConnection;
  row: TransferRow;
  abort: AbortController;
  task?: Promise<unknown>;
  cleanup?: Promise<void>;
  completed: boolean;
  cleanupVerified: boolean;
  timer: ReturnType<typeof setTimeout>;
  publication: Promise<void>;
  published(): void;
  failed(error: unknown): void;
  check(): void;
  validate(): Promise<TransferRow>;
}

export function createTransferLifetime(store: Store, hub: Hub) {
  const active = new Map<string, ActiveCheckpointTransfer>();
  let closed = false;
  const jobs = new Set<{ workspaceId: string; task: Promise<unknown> }>();
  const preparations = new Map<string, { connection: LiveConnection; task: Promise<unknown> }>();
  function ensureOpen() {
    if (closed) throw new Error("Checkpoint transfers are closed.");
  }
  async function settle(results: PromiseSettledResult<unknown>[]) {
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }
  function cancelPreparations(workspaceId?: string, connection?: LiveConnection) {
    for (const [operationId, prepare] of preparations)
      if (
        (!workspaceId || prepare.connection.workspaceId === workspaceId) &&
        (!connection || prepare.connection === connection)
      )
        hub.resolveCheckpoint(prepare.connection, operationId, "failed");
  }

  async function cleanup(
    context: ActiveCheckpointTransfer,
    reason: unknown = new Error("Checkpoint transfer interrupted."),
  ) {
    context.cleanup ??= (async () => {
      context.abort.abort(reason);
      clearTimeout(context.timer);
      await context.task?.catch(() => {});
      if (!context.cleanupVerified) throw new Error("Checkpoint owned cleanup is incomplete; storage remains charged.");
      if (!context.completed) await store.checkpointTransfers.abort(context.row.id, () => {});
      active.delete(context.row.id);
      context.failed(reason);
    })();
    return context.cleanup;
  }
  function open(connection: LiveConnection, row: TransferRow) {
    ensureOpen();
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const publication = new Promise<void>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    void publication.catch(() => {});
    const context: ActiveCheckpointTransfer = {
      connection,
      row,
      abort: new AbortController(),
      completed: false,
      cleanupVerified: true,
      publication,
      published() {
        context.completed = true;
        clearTimeout(context.timer);
        active.delete(row.id);
        resolve();
      },
      failed: reject,
      timer: setTimeout(
        () => {
          void cleanup(context, new Error("Checkpoint transfer deadline expired.")).catch(reject);
        },
        Math.max(1, row.expiresAt.getTime() - Date.now()),
      ),
      check() {
        context.abort.signal.throwIfAborted();
        if (
          closed ||
          hub.get(row.workspaceId) !== connection ||
          !connection.registered ||
          connection.epoch !== row.connectionEpoch ||
          !Number.isFinite(row.expiresAt.getTime()) ||
          row.expiresAt <= new Date()
        )
          throw new Error("Checkpoint live connection authority changed.");
      },
      async validate() {
        context.check();
        const current = await store.checkpointTransfers.validate(row.id, context.check);
        context.check();
        if (
          current.operationId !== row.operationId ||
          current.checkpointId !== row.checkpointId ||
          current.workspaceId !== row.workspaceId ||
          current.principalId !== row.principalId ||
          current.direction !== row.direction ||
          current.connectionEpoch !== row.connectionEpoch ||
          current.expiresAt.getTime() !== row.expiresAt.getTime()
        )
          throw new Error("Checkpoint live transfer binding changed.");
        return current;
      },
    };
    active.set(row.id, context);
    return context;
  }
  return {
    active,
    ensureOpen,
    run<T>(workspaceId: string, action: () => Promise<T>) {
      ensureOpen();
      const task = Promise.resolve().then(action);
      const job = { workspaceId, task };
      jobs.add(job);
      void task.then(
        () => jobs.delete(job),
        () => jobs.delete(job),
      );
      return task;
    },
    prepare(workspaceId: string, payload: PrepareCheckpointArchive) {
      ensureOpen();
      const connection = hub.get(workspaceId);
      const task = hub.prepareCheckpointArchive(workspaceId, payload);
      if (connection) preparations.set(payload.operation_id, { connection, task });
      void task.then(
        () => preparations.delete(payload.operation_id),
        () => preparations.delete(payload.operation_id),
      );
      return task;
    },
    open,
    cleanup,
    async cleanupWorkspace(workspaceId: string, connection?: LiveConnection) {
      cancelPreparations(workspaceId, connection);
      const contexts = [...active.values()].filter(
        (context) => context.row.workspaceId === workspaceId && (!connection || context.connection === connection),
      );
      const results = await Promise.allSettled(contexts.map((context) => cleanup(context)));
      await settle(results);
      await Promise.allSettled([...jobs].filter((job) => job.workspaceId === workspaceId).map((job) => job.task));
    },
    async drain() {
      closed = true;
      cancelPreparations();
      const results = await Promise.allSettled([...active.values()].map((context) => cleanup(context)));
      await Promise.allSettled([...jobs].map((job) => job.task));
      await settle(results);
    },
  };
}
export type TransferLifetime = ReturnType<typeof createTransferLifetime>;
