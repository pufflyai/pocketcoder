import { randomUUID } from "node:crypto";
import { ApiError, digestOf, isTerminal } from "@pstdio/pocketcoder-contracts";
import {
  type PrincipalRow,
  stopWorkspaceProvider,
  type WorkspaceOperationRow,
  type WorkspaceRow,
} from "@pstdio/pocketcoder-runtime-core";
import type { PersistenceContext } from "./persistence-base";
import type { PersistencePreserveRunner } from "./persistence-preserve-runner";
import { PurgeOwnershipError, purgeStorage } from "./purge-storage";

export class PersistencePurgeService {
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly context: PersistenceContext,
    private readonly preserves: PersistencePreserveRunner,
  ) {}

  async purge(principal: PrincipalRow, workspaceId: string, idempotencyKey: string) {
    await this.context.deps.workspaces.getOwned(principal, workspaceId);
    const at = this.context.now();
    const result = await this.context.insertOperation({
      id: randomUUID(),
      principalId: principal.id,
      kind: "purge",
      state: "pending",
      idempotencyKey,
      requestDigest: digestOf({ workspace_id: workspaceId }),
      workspaceId,
      checkpointId: null,
      resultWorkspaceId: null,
      reasonCode: null,
      attemptCount: 0,
      createdAt: at,
      updatedAt: at,
      completedAt: null,
    });
    if (result.conflict) throw new ApiError("idempotency.conflict", "Changed purge request.");
    if (result.operation.state !== "succeeded") void this.run(result.operation).catch(() => {});
    return result.operation;
  }

  async retry() {
    const operations = await this.context.deps.store.listIncompleteOperations();
    await Promise.all(
      operations.filter((operation) => operation.kind === "purge").map((operation) => this.run(operation)),
    );
    return (await this.context.deps.store.listIncompleteOperations()).filter((operation) => operation.kind === "purge")
      .length;
  }

  private run(operation: WorkspaceOperationRow) {
    const workspaceId = operation.workspaceId;
    if (!workspaceId) return Promise.resolve();
    const active = this.running.get(workspaceId);
    if (active) return active;
    const task = this.attempt(operation, workspaceId).finally(() => this.running.delete(workspaceId));
    this.running.set(workspaceId, task);
    this.context.track(task);
    return task;
  }

  private async attempt(operation: WorkspaceOperationRow, workspaceId: string) {
    const { store, scheduler, driver, hub } = this.context.deps;
    let reason = "purge_journal_pending";
    try {
      // A restart can see a committed intent whose remote acknowledgement failed.
      await store.acknowledgeJournal?.();
      reason = "purge_termination_unresolved";
      await store.updateOperation(
        operation.id,
        { state: "running", reasonCode: null, attemptCount: operation.attemptCount + 1 },
        this.context.now(),
      );
      // Drain a launch already admitted by this single controller before
      // inspecting its provider and storage references.
      await scheduler.drain();
      // Transfer cleanup fails only while owned files remain.
      reason = "purge_storage_unavailable";
      await this.cancelCopies(operation.principalId, workspaceId);
      reason = "purge_termination_unresolved";
      const workspace = await store.getWorkspace(workspaceId);
      if (!workspace) throw new Error("Workspace missing");
      await this.context.deps.revokeWorkspaceLeases?.(workspaceId);
      if (await this.hasActiveCopies(workspaceId, workspace.state === "queued")) {
        reason = "purge_operation_in_progress";
        throw new Error(reason);
      }
      if (driver.kind === "kubernetes" && (workspace.launchAttempts > 0 || workspace.providerRef)) {
        // Job disappearance cannot prove a disconnected node stopped. Capture
        // proof before any removal, or require the proof saved by an earlier stop.
        await stopWorkspaceProvider(store, driver, workspace, 1, this.context.now(), false);
        const stopped = await store.getWorkspace(workspaceId);
        if (!stopped?.providerRef?.terminationEvidence) throw new Error(reason);
      }
      hub.close(workspaceId);
      if (!isTerminal(workspace.state)) {
        if (workspace.state === "queued") {
          await store.transition(workspaceId, {
            from: ["queued"],
            to: "canceled",
            reason: "canceled_by_caller",
            at: this.context.now(),
          });
        } else if (workspace.state === "preserving") {
          // A failed upload keeps its source preserving for recovery. Purge ends it.
          await scheduler.beginTermination(workspace, "canceled", "canceled_by_caller", this.context.now());
          await scheduler.drain();
        } else {
          await scheduler.finalize(workspace, "canceled", "canceled_by_caller", this.context.now());
        }
        if (!(await store.getWorkspace(workspaceId))?.terminalAt) throw new Error(reason);
      }
      // Terminal rows can retain provider references after an interrupted
      // removal. A missing API object alone is not termination evidence.
      const current = await store.getWorkspace(workspaceId);
      if (!current) throw new Error("Workspace missing");
      await stopWorkspaceProvider(store, driver, current, 1, this.context.now());
      const providers = (await driver.list()).filter((provider) => provider.workspaceId === workspaceId);
      if (providers.length) throw new Error(reason);
      reason = "purge_storage_unavailable";
      await driver.purgeInput(workspaceId);
      await purgeStorage(this.context, workspace);
      await store.purgeWorkspaceContent(workspaceId, this.context.now());
      const done = this.context.now();
      await store.updateOperation(operation.id, { state: "succeeded", reasonCode: null, completedAt: done }, done);
    } catch (error) {
      if (error instanceof PurgeOwnershipError) reason = "purge_ownership_unresolved";
      await store.updateOperation(
        operation.id,
        { state: "pending", reasonCode: reason, completedAt: null },
        this.context.now(),
      );
    }
  }

  // The purge fence blocks every new grant and write. Cancel admitted copies
  // now instead of waiting for their transfer deadline.
  private async cancelCopies(principalId: string, workspaceId: string) {
    const transfers = this.context.deps.checkpointTransfers;
    if (!transfers) return;
    const checkpoints = await this.context.deps.store.listCheckpoints(principalId, { workspaceId });
    await transfers.cancel(workspaceId, new Set(checkpoints.map((checkpoint) => checkpoint.id)));
    await this.preserves.settled(workspaceId);
  }

  private async transfersFrom(operation: WorkspaceOperationRow) {
    if (!operation.checkpointId) return false;
    const checkpoint = await this.context.deps.store.getCheckpoint(operation.checkpointId);
    return checkpoint?.providerKind === "controller-archive";
  }

  // A transferred restore cannot become ready after its source is purged, but
  // its destination may already hold copied bytes. End it before deleting.
  private async endRestore(target: WorkspaceRow) {
    const { store, scheduler } = this.context.deps;
    const at = this.context.now();
    if (target.state === "queued") {
      await store.transition(target.id, { from: ["queued"], to: "failed", reason: "restore_failed", at });
    } else if (target.state !== "terminating") {
      await scheduler.beginTermination(target, "failed", "restore_failed", at);
    }
    await scheduler.drain();
    return store.getWorkspace(target.id);
  }

  private async hasActiveCopies(workspaceId: string, queued: boolean) {
    const operations = await this.context.deps.store.listIncompleteOperations();
    let active = false;
    for (const operation of operations) {
      if (operation.kind === "purge") continue;
      if (operation.kind === "restore" && (await this.settleRestore(operation, workspaceId, queued))) continue;
      if (operation.workspaceId === workspaceId || operation.resultWorkspaceId === workspaceId) active = true;
    }
    return active;
  }

  // Returns true when this restore no longer blocks the purge.
  private async settleRestore(operation: WorkspaceOperationRow, workspaceId: string, queued: boolean) {
    if (!operation.resultWorkspaceId) return false;
    const transferred = await this.transfersFrom(operation);
    let target = await this.context.deps.store.getWorkspace(operation.resultWorkspaceId);
    const live = target && !isTerminal(target.state);
    // Purge ends this destination below, and ending it fails its restore.
    if (transferred && live && target?.id === workspaceId && !queued) return true;
    if (transferred && live && target && operation.workspaceId === workspaceId) target = await this.endRestore(target);
    if (target && isTerminal(target.state)) {
      await this.context.failOperation(operation.id, "restore_failed");
      return true;
    }
    // Admission is fenced and the scheduler has drained. A queued restore
    // target cannot start, so waiting for its copy would deadlock cleanup.
    if (queued && operation.resultWorkspaceId === workspaceId) {
      await this.context.failOperation(operation.id, "canceled_by_caller");
      return true;
    }
    return false;
  }
}
