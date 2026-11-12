import {
  type ExecutionRecord,
  executionInputManifestId,
  executionNeedsAcknowledgment,
  executionSettled,
  type WorkloadExecutionReference,
} from "@pstdio/pocketcoder-contracts";
import { InputProjectionCapacityError } from "@pstdio/pocketcoder-runtime-contracts";
import type { Store, WorkspaceRow } from "../types";
import { releaseUnsentExecution } from "./execution-finalization";
import { executionUnhealthy, producerMissing } from "./execution-health";

export { EXECUTION_FAILURE_WAIT_MS, PROJECTION_CAPACITY_WAIT_MS } from "./execution-health";

// The producer answered the accept with a client error: it will not run this execution as sent.
export class ExecutionRefusedError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ExecutionRefusedError";
  }
}

export interface ExecutionTransport {
  connected(workspace: WorkspaceRow): boolean;
  accept(record: ExecutionRecord, workspace: WorkspaceRow): Promise<void>;
  lookup(record: ExecutionRecord, workspace: WorkspaceRow): Promise<"absent" | undefined>;
  cancel(record: ExecutionRecord, workspace: WorkspaceRow): Promise<void>;
  acknowledge(record: ExecutionRecord, workspace: WorkspaceRow): Promise<void>;
  // Finalizes an execution locally, without contacting the producer (it never accepted it).
  release?(record: ExecutionRecord, workspace: WorkspaceRow): Promise<void>;
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
  private readonly failures = new Map<string, { workspaceId: string; since: number }>();
  // A request that keeps failing is retried after a growing pause, not on every scan.
  private readonly retries = new Map<string, { failures: number; dueAt: number }>();
  // Claimed requests whose input publication waited for capacity: nothing reached the producer yet.
  private readonly capacityWaits = new Map<string, number>();

  constructor(
    private readonly deps: {
      store: Store;
      transport: ExecutionTransport;
      inspect(workspace: WorkspaceRow): Promise<{ exists: boolean; running: boolean; containerIdentity?: string }>;
      now?: () => Date;
      concurrency?: number;
      sessionSeedBytes?: number;
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
    return !executionSettled(record) || executionNeedsAcknowledgment(record);
  }

  private allowed() {
    return !this.stopped && (this.deps.canDispatch?.() ?? true);
  }

  private async scanPending() {
    do {
      this.dirty = false;
      await this.deps.store.managed.requests.prepare(this.now(), this.deps.sessionSeedBytes);
      const pending = await this.deps.store.executions.pending();
      this.reconcileFailures(pending);
      for (const record of pending) {
        if (!this.allowed()) return;
        const key = executionInputManifestId(record.acceptance);
        const control = Boolean(record.cancel && this.cancelPending(record));
        if (!this.retryDue(`${key}:${control}`)) continue;
        if (control) this.cancel(record);
        else {
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
      if (!keys.has(identity) && !this.ordinary.has(identity) && !this.controls.has(identity)) this.settled(key);
    }
    for (const key of this.capacityWaits.keys()) if (!keys.has(key)) this.capacityWaits.delete(key);
    this.deps.onHealth?.(this.unhealthy());
  }

  private clock() {
    return this.now().getTime();
  }
  private now = () => this.deps.now?.() ?? new Date();

  private retryDue(failureKey: string) {
    return this.clock() >= (this.retries.get(failureKey)?.dueAt ?? 0);
  }

  private failed(failureKey: string, workspaceId: string) {
    const now = this.clock();
    this.failures.set(failureKey, { workspaceId, since: this.failures.get(failureKey)?.since ?? now });
    const failures = (this.retries.get(failureKey)?.failures ?? 0) + 1;
    // The first retry is immediate; later ones wait 2 s, doubling to 5 min.
    const delay = failures === 1 ? 0 : Math.min(2_000 * 2 ** (failures - 2), 300_000);
    this.retries.set(failureKey, { failures, dueAt: now + delay });
  }

  private settled(failureKey: string) {
    this.failures.delete(failureKey);
    this.retries.delete(failureKey);
  }

  // Readiness reflects controller-wide trouble only: input capacity stuck past its wait, or requests failing in
  // more than one workspace for longer than a single producer's trouble explains.
  private unhealthy() {
    return executionUnhealthy(this.failures.values(), this.capacityWaits.values(), this.clock());
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
            this.settled(failureKey);
            if (executionSettled(record)) {
              this.settled(`${key}:true`);
              this.settled(`${key}:false`);
            }
          }
        },
        (error) => {
          // A capacity wait reached nothing; it is retried on every scan and reported through its own bound.
          if (!(error instanceof InputProjectionCapacityError)) this.failed(failureKey, workspaceId);
          this.deps.onError?.(error);
        },
      )
      .finally(() => {
        lane.delete(key);
        this.deps.onHealth?.(this.unhealthy());
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
    if (record.phase === "running") {
      await this.deps.store.executions.observe(
        execution,
        record.acceptance.fingerprint,
        "unknown",
        epoch,
        this.deps.now?.() ?? new Date(),
        record.outcome,
      );
      return null;
    }
    return record;
  }

  private async dispatch(record: ExecutionRecord, control: boolean, absentEpoch?: number) {
    const { store, transport } = this.deps;
    const now = this.now();
    const execution = record.acceptance.execution;
    const workspace = await store.getWorkspace(execution.workspaceId);
    if (!workspace || workspace.purgeRequestedAt) return;
    if (await releaseUnsentExecution(record, workspace, transport)) return true;
    if (!transport.connected(workspace)) return;
    if (absentEpoch !== undefined && workspace.connectionEpoch !== absentEpoch) return;
    const observed = await this.deps.inspect(workspace);
    if (producerMissing(observed, execution.incarnationId)) {
      await store.endWorkspaceRuntime(workspace.id, execution.incarnationId, now);
      return true;
    }
    if (executionSettled(record)) {
      if (control && !record.cancel) return;
      await transport.acknowledge(record, workspace);
      return true;
    }
    const resend = this.mustResend(record, control, absentEpoch);
    const claim =
      record.dispatchClaimedAt && !resend
        ? await store.executions.reconcile(execution)
        : await store.executions.claim(execution, now);
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
    await this.dispatchOrdinary(current, workspace, claim.first || resend, now);
    return true;
  }

  // The producer reported the request absent, or it only waited for publication capacity and was never sent.
  private mustResend(record: ExecutionRecord, control: boolean, absentEpoch?: number) {
    if (absentEpoch !== undefined) return true;
    return !control && this.capacityWaits.has(executionInputManifestId(record.acceptance));
  }

  private async dispatchCancel(record: ExecutionRecord, workspace: WorkspaceRow, now: Date) {
    if (this.capabilities(workspace, record).includes("targeted-cancel"))
      await this.deps.transport.cancel(record, workspace);
    else await this.unknown(record, workspace, now);
  }

  private async dispatchOrdinary(record: ExecutionRecord, workspace: WorkspaceRow, accept: boolean, now: Date) {
    const key = executionInputManifestId(record.acceptance);
    if (accept) {
      try {
        await this.deps.transport.accept(record, workspace);
      } catch (error) {
        if (error instanceof ExecutionRefusedError) return this.refused(record, workspace, error, now);
        if (error instanceof InputProjectionCapacityError && !this.capacityWaits.has(key))
          this.capacityWaits.set(key, now.getTime());
        throw error;
      }
      this.capacityWaits.delete(key);
    } else if (this.canReconcile(workspace, record)) {
      if ((await this.deps.transport.lookup(record, workspace)) === "absent") {
        const latest = await this.replayable(record.acceptance.execution, workspace.connectionEpoch);
        if (latest && this.allowed()) await this.dispatch(latest, false, workspace.connectionEpoch);
      }
    } else await this.unknown(record, workspace, now);
  }

  // A refused request is settled, never resent. A producer that can look it up reports whether a refused
  // retry was in fact already running; otherwise the refusal is the answer.
  private async refused(record: ExecutionRecord, workspace: WorkspaceRow, error: ExecutionRefusedError, now: Date) {
    const { store, transport } = this.deps;
    if (this.canReconcile(workspace, record) && (await transport.lookup(record, workspace)) !== "absent") return;
    const { execution, fingerprint } = record.acceptance;
    const outcome = { refused: { status: error.status, message: error.message } };
    await store.executions.observe(execution, fingerprint, "terminal", workspace.connectionEpoch, now, outcome);
    await store.executions.acknowledge(execution, fingerprint, now);
    await transport.release?.(record, workspace);
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
