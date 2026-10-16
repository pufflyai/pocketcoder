import {
  type ExecutionRecord,
  executionInputManifestId,
  executionSettled,
  type WorkloadExecutionReference,
} from "@pstdio/pocketcoder-contracts";
import type { Store, WorkspaceRow } from "../types";

export interface ExecutionTransport {
  connected(workspace: WorkspaceRow): boolean;
  accept(record: ExecutionRecord, workspace: WorkspaceRow): Promise<void>;
  lookup(record: ExecutionRecord, workspace: WorkspaceRow): Promise<"absent" | undefined>;
  cancel(record: ExecutionRecord, workspace: WorkspaceRow): Promise<void>;
  acknowledge(record: ExecutionRecord, workspace: WorkspaceRow): Promise<void>;
}

type DispatchTask = { workspaceId: string; promise: Promise<void> };

// Transport waits never own the coordinator tick. Cancellation has its own lane,
// including when the same execution is still publishing inputs or awaiting accept.
export class ExecutionDispatcher {
  private scan: Promise<void> | null = null;
  private dirty = false;
  private stopped = false;
  private readonly ordinary = new Map<string, DispatchTask>();
  private readonly controls = new Map<string, DispatchTask>();
  private readonly queued = new Map<string, { record: ExecutionRecord; epoch?: number }>();
  private readonly absences = new Map<string, number>();
  private readonly failures = new Set<string>();

  constructor(
    private readonly deps: {
      store: Store;
      transport: ExecutionTransport;
      inspect(workspace: WorkspaceRow): Promise<{ exists: boolean; running: boolean; containerIdentity?: string }>;
      now?: () => Date;
      concurrency?: number;
      canDispatch?: () => boolean;
      onHealth?: (failed: boolean) => void;
      onError?: (error: unknown) => void;
    },
  ) {}

  tick(): Promise<void> {
    if (!this.allowed()) return Promise.resolve();
    this.dirty = true;
    this.scan ??= this.scanPending().finally(() => {
      this.scan = null;
      if (this.dirty && this.allowed()) return this.tick();
    });
    return this.scan;
  }

  // Called only after durable cancel admission. It does not start ordinary work,
  // even if an admitted HTTP request finishes as maintenance begins.
  cancel(record: ExecutionRecord) {
    if (!this.stopped && record.cancel && this.cancelPending(record)) this.start(record, true);
  }

  async absent(execution: WorkloadExecutionReference, epoch: number) {
    const record = await this.replayable(execution, epoch);
    if (!record || !this.allowed()) return;
    const key = executionInputManifestId(record.acceptance);
    if (this.ordinary.has(key)) this.absences.set(key, epoch);
    else {
      this.queued.set(key, { record, epoch });
      this.pump();
    }
  }

  async drain(workspaceId?: string) {
    if (workspaceId)
      for (const [key, item] of this.queued)
        if (item.record.acceptance.execution.workspaceId === workspaceId) this.queued.delete(key);
    do {
      await this.scan;
      const tasks = [...this.ordinary.values(), ...this.controls.values()].filter(
        (task) => !workspaceId || task.workspaceId === workspaceId,
      );
      if (!tasks.length) return;
      await Promise.all(tasks.map((task) => task.promise));
    } while (this.scan || this.ordinary.size || this.controls.size);
  }

  async stop() {
    this.stopped = true;
    this.queued.clear();
    this.absences.clear();
    await this.drain();
  }

  private cancelPending(record: ExecutionRecord) {
    return (
      !executionSettled(record) ||
      (["terminal", "canceled"].includes(record.phase) && !!record.dispatchClaimedAt && !record.acknowledgedAt)
    );
  }

  private allowed() {
    return !this.stopped && (this.deps.canDispatch?.() ?? true);
  }

  private async scanPending() {
    do {
      this.dirty = false;
      const pending = await this.deps.store.executions.pending();
      this.reconcileFailures(pending);
      for (const record of pending) {
        if (!this.allowed()) return;
        if (record.cancel && this.cancelPending(record)) this.cancel(record);
        else {
          const key = executionInputManifestId(record.acceptance);
          if (!this.ordinary.has(key) && !this.controls.has(key) && !this.queued.has(key))
            this.queued.set(key, { record });
        }
      }
      this.pump();
    } while (this.dirty && this.allowed());
  }

  private reconcileFailures(pending: ExecutionRecord[]) {
    const keys = new Set(pending.map((record) => executionInputManifestId(record.acceptance)));
    for (const key of this.failures.keys()) {
      const identity = key.slice(0, key.lastIndexOf(":"));
      if (!keys.has(identity) && !this.ordinary.has(identity) && !this.controls.has(identity))
        this.failures.delete(key);
    }
    this.deps.onHealth?.(this.failures.size > 0);
  }

  private pump() {
    if (!this.allowed()) {
      this.queued.clear();
      return;
    }
    for (const [key, item] of this.queued) {
      if (this.ordinary.size >= (this.deps.concurrency ?? 1)) break;
      this.queued.delete(key);
      if (!this.controls.has(key)) this.start(item.record, false, item.epoch);
    }
  }

  private start(record: ExecutionRecord, control: boolean, epoch?: number) {
    const key = executionInputManifestId(record.acceptance);
    const lane = control ? this.controls : this.ordinary;
    if (lane.has(key)) return;
    const workspaceId = record.acceptance.execution.workspaceId;
    const failureKey = `${key}:${control}`;
    const promise = this.dispatch(record, control, epoch)
      .then(
        (performed) => {
          if (performed) {
            this.failures.delete(failureKey);
            if (executionSettled(record)) {
              this.failures.delete(`${key}:true`);
              this.failures.delete(`${key}:false`);
            }
          }
        },
        (error) => {
          this.failures.add(failureKey);
          this.deps.onError?.(error);
        },
      )
      .finally(() => {
        lane.delete(key);
        this.deps.onHealth?.(this.failures.size > 0);
        const replayEpoch = this.absences.get(key);
        if (!control) this.absences.delete(key);
        if (!control && replayEpoch !== undefined && this.allowed())
          this.queued.set(key, { record, epoch: replayEpoch });
        this.pump();
      });
    lane.set(key, { workspaceId, promise });
  }

  private async replayable(execution: WorkloadExecutionReference, epoch: number) {
    const workspace = await this.deps.store.getWorkspace(execution.workspaceId);
    const record = await this.deps.store.executions.get(execution);
    if (
      !workspace ||
      !record ||
      workspace.connectionEpoch !== epoch ||
      !record.dispatchClaimedAt ||
      executionSettled(record) ||
      !this.canReconcile(workspace, record)
    )
      return null;
    return record;
  }

  private async dispatch(record: ExecutionRecord, control: boolean, absentEpoch?: number) {
    const { store, transport } = this.deps;
    const now = this.deps.now?.() ?? new Date();
    const execution = record.acceptance.execution;
    const workspace = await store.getWorkspace(execution.workspaceId);
    if (!workspace || workspace.purgeRequestedAt || !transport.connected(workspace)) return;
    if (absentEpoch !== undefined && workspace.connectionEpoch !== absentEpoch) return;
    const observed = await this.deps.inspect(workspace);
    if (!observed.exists || !observed.running || observed.containerIdentity !== execution.incarnationId) {
      await store.endWorkspaceRuntime(workspace.id, execution.incarnationId, now);
      return true;
    }
    if (executionSettled(record)) {
      if (control && !record.cancel) return;
      await transport.acknowledge(record, workspace);
      return true;
    }
    const claim = await store.executions.claim(execution, now);
    if (!claim) return;
    const current = claim.record;
    if (current.cancel) {
      if (!control) {
        this.cancel(current);
        return;
      }
      await this.dispatchCancel(current, workspace, now);
      return true;
    }
    if (control || !this.allowed()) return;
    await this.dispatchOrdinary(current, workspace, claim.first || absentEpoch !== undefined, now);
    return true;
  }

  private async dispatchCancel(record: ExecutionRecord, workspace: WorkspaceRow, now: Date) {
    if (this.capabilities(workspace, record).includes("targeted-cancel"))
      await this.deps.transport.cancel(record, workspace);
    else await this.unknown(record, workspace, now);
  }

  private async dispatchOrdinary(record: ExecutionRecord, workspace: WorkspaceRow, accept: boolean, now: Date) {
    if (accept) await this.deps.transport.accept(record, workspace);
    else if (this.canReconcile(workspace, record)) {
      if ((await this.deps.transport.lookup(record, workspace)) === "absent") {
        const latest = await this.replayable(record.acceptance.execution, workspace.connectionEpoch);
        if (latest && this.allowed()) await this.dispatch(latest, false, workspace.connectionEpoch);
      }
    } else await this.unknown(record, workspace, now);
  }

  private unknown(record: ExecutionRecord, workspace: WorkspaceRow, now: Date) {
    return this.deps.store.executions.observe(
      record.acceptance.execution,
      record.acceptance.fingerprint,
      "unknown",
      workspace.connectionEpoch,
      now,
    );
  }

  private capabilities(workspace: WorkspaceRow, record: ExecutionRecord) {
    const operation = workspace.runtimeRegistration?.template?.manifest.spec.operations[record.acceptance.operation];
    return operation ? (workspace.runtimeRegistration?.producer?.adapters[operation.adapter]?.capabilities ?? []) : [];
  }
  private canReconcile(workspace: WorkspaceRow, record: ExecutionRecord) {
    const caps = this.capabilities(workspace, record);
    return caps.includes("request-lookup") && caps.includes("deduplicated-accept");
  }
}
