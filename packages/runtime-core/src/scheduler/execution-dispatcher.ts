import { type ExecutionRecord, executionSettled, type WorkloadExecutionReference } from "@pstdio/pocketcoder-contracts";
import type { Store, WorkspaceRow } from "../types";

export interface ExecutionTransport {
  connected(workspace: WorkspaceRow): boolean;
  accept(record: ExecutionRecord, workspace: WorkspaceRow): Promise<void>;
  lookup(record: ExecutionRecord, workspace: WorkspaceRow): Promise<"absent" | undefined>;
  cancel(record: ExecutionRecord, workspace: WorkspaceRow): Promise<void>;
  acknowledge(record: ExecutionRecord, workspace: WorkspaceRow): Promise<void>;
}

// The controller owns dispatch. HTTP handlers only write intent at the existing owners.
export class ExecutionDispatcher {
  private active: Promise<void> | null = null;
  constructor(
    private readonly deps: {
      store: Store;
      transport: ExecutionTransport;
      inspect(workspace: WorkspaceRow): Promise<{ exists: boolean; running: boolean; containerIdentity?: string }>;
      now?: () => Date;
      concurrency?: number;
    },
  ) {}

  tick() {
    this.active ??= this.dispatchPending().finally(() => {
      this.active = null;
    });
    return this.active;
  }

  async absent(execution: WorkloadExecutionReference, epoch: number) {
    const { store } = this.deps;
    const workspace = await store.getWorkspace(execution.workspaceId);
    const record = await store.executions.get(execution);
    if (
      !workspace ||
      !record ||
      workspace.connectionEpoch !== epoch ||
      !record.dispatchClaimedAt ||
      executionSettled(record) ||
      !this.canReconcile(workspace, record)
    )
      return;
    await this.dispatch(record, true);
  }

  private async dispatchPending() {
    const errors: unknown[] = [];
    const pending = await this.deps.store.executions.pending();
    let next = 0;
    const worker = async () => {
      while (next < pending.length) {
        const record = pending[next++];
        if (!record) return;
        try {
          await this.dispatch(record, false);
        } catch (error) {
          errors.push(error);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.deps.concurrency ?? 1, pending.length) }, worker));
    if (errors.length) throw new AggregateError(errors, "Execution dispatch needs reconciliation");
  }

  private async dispatch(record: ExecutionRecord, provenAbsent: boolean) {
    const { store, transport } = this.deps;
    const now = this.deps.now?.() ?? new Date();
    const execution = record.acceptance.execution;
    const workspace = await store.getWorkspace(execution.workspaceId);
    if (!workspace || !transport.connected(workspace)) return;
    // A daemon error must propagate. It is not proof of runtime loss.
    const observed = await this.deps.inspect(workspace);
    if (!observed.exists || !observed.running || observed.containerIdentity !== execution.incarnationId) {
      await store.endWorkspaceRuntime(workspace.id, execution.incarnationId, now);
      return;
    }
    if (executionSettled(record)) {
      await transport.acknowledge(record, workspace);
      return;
    }
    const claim = await store.executions.claim(execution, now);
    if (!claim) return;
    const current = claim.record;
    if (current.cancel) {
      if (this.capabilities(workspace, current).includes("targeted-cancel")) await transport.cancel(current, workspace);
      else
        await store.executions.observe(
          execution,
          current.acceptance.fingerprint,
          "unknown",
          workspace.connectionEpoch,
          now,
        );
      return;
    }
    if (claim.first || provenAbsent) await transport.accept(current, workspace);
    else if (this.canReconcile(workspace, current)) {
      if ((await transport.lookup(current, workspace)) === "absent")
        await this.absent(execution, workspace.connectionEpoch);
    } else
      await store.executions.observe(
        execution,
        current.acceptance.fingerprint,
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
