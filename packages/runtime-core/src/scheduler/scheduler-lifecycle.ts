import { parseDurationMs, type ReasonCode, type WorkspaceState } from "@pstdio/pocketcoder-contracts";
import type { WorkspacePatch, WorkspaceRow } from "../types";
import { cleanupUncommittedProvider, stopWorkspaceProvider } from "./provider-termination";
import { decodeFailureLogTail, FAILURE_LOG_TAIL_BYTES, type SchedulerContext } from "./scheduler-base";

// A provider that cannot answer is asked again after a growing pause, not on every scheduler tick.
const CLEANUP_RETRY_BASE_MS = 2_000;
const CLEANUP_RETRY_MAX_MS = 300_000;

export class SchedulerLifecycle {
  private readonly cleanupRetries = new Map<string, { failures: number; dueAt: number }>();
  constructor(private readonly context: SchedulerContext) {}

  cleanupRetryDue(workspaceId: string, now: Date) {
    return now.getTime() >= (this.cleanupRetries.get(workspaceId)?.dueAt ?? 0);
  }
  async beginTermination(
    row: WorkspaceRow,
    terminalState: WorkspaceState,
    reason: ReasonCode,
    at: Date,
  ): Promise<WorkspaceRow | null> {
    const { store, connections } = this.context.deps;
    const updated = await store.transition(row.id, {
      from: ["provisioning", "connected", "ready", "preserving"],
      to: "terminating",
      reason,
      at,
      patch: { terminalIntent: terminalState },
      ...(reason === "deadline_expired" ? { expectedDeadlineAt: row.deadlineAt } : {}),
    });
    if (!updated) {
      return null;
    }
    const connected = connections.isConnected(row.id);
    if (connected) {
      connections.shutdown(row.id, reason);
      connections.signal(row.id, "TERM");
    }
    if (updated.providerRef) {
      // docker stop / Job deletion performs TERM, grace, KILL.
      this.finalize(updated, terminalState, reason, this.context.now()).catch((err) =>
        this.context.report(`terminate.${row.id}`, err),
      );
    } else {
      await this.finalize(updated, terminalState, reason, at);
    }
    return updated;
  }

  finalize(row: WorkspaceRow, terminalState: WorkspaceState, reason: ReasonCode | null, at: Date) {
    return this.context.trackFinalizer(this.finalizeProvider(row, terminalState, reason, at));
  }

  private async finalizeProvider(
    row: WorkspaceRow,
    terminalState: WorkspaceState,
    reason: ReasonCode | null,
    at: Date,
  ) {
    const { store, driver, connections } = this.context.deps;
    const retainStorage =
      terminalState === "failed" &&
      row.templateSnapshot.spec.persistence.checkpoint.onFailure === "retain-for-recovery";
    try {
      await this.context.deps.revokeWorkspaceLeases?.(row.id);
      if (row.providerRef) {
        await stopWorkspaceProvider(store, driver, row, this.context.graceSeconds(row), at);
        await driver.purgeInput(row.id);
      } else {
        await cleanupUncommittedProvider(store, driver, row, this.context.graceSeconds(row), at);
      }
    } catch (err) {
      const failures = (this.cleanupRetries.get(row.id)?.failures ?? 0) + 1;
      const delay = Math.min(CLEANUP_RETRY_BASE_MS * 2 ** (failures - 1), CLEANUP_RETRY_MAX_MS);
      this.cleanupRetries.set(row.id, { failures, dueAt: this.context.now().getTime() + delay });
      this.context.report(`finalize.terminate.${row.id}`, err);
      // Keep the workspace active until removal and input cleanup can be retried.
      await store.transition(row.id, {
        from: ["provisioning", "connected", "ready"],
        to: "terminating",
        reason,
        at,
        patch: { terminalIntent: terminalState, registrationDigest: null },
      });
      return;
    }
    this.cleanupRetries.delete(row.id);
    // Stop proof precedes extraction; output storage stays allocated until the
    // collection receipt and immutable bytes are committed together.
    if (row.runtimeRegistration) await store.endWorkspaceRuntime(row.id, row.runtimeRegistration.incarnationId, at);
    await this.context.deps.finalizeOutputs?.(row);
    if (retainStorage && !this.context.deps.transferRuntime) {
      const storage = await store.getWorkspaceStorage(row.id);
      if (storage && !["retained", "deleted"].includes(storage.state)) {
        await store.updateWorkspaceStorage(
          storage.id,
          {
            state: "retained",
            retainedUntil: new Date(
              at.getTime() + parseDurationMs(row.templateSnapshot.spec.persistence.checkpoint.retention),
            ),
          },
          at,
        );
      }
    } else {
      await this.context.cleanupWorkspaceStorage(row);
      await this.context.deps.completeOutputCleanup?.(row);
    }
    let failurePatch: WorkspacePatch = {};
    if (terminalState === "failed") {
      try {
        const tail = await store.readLogTail(row.id, FAILURE_LOG_TAIL_BYTES);
        failurePatch = {
          failureLogTail: decodeFailureLogTail(tail.content, tail.truncated),
          failureLogTailTruncated: tail.truncated,
          failureLastLogSeq: tail.lastSeq,
        };
      } catch (error) {
        this.context.report(`finalize.log-tail.${row.id}`, error);
      }
    }
    connections.close(row.id);
    if (this.context.deps.transferRuntime && row.restoredFromCheckpointId) {
      await this.context.finishRestoreOperation(row, "failed", "restore_failed");
    }
    await store.transition(row.id, {
      from: ["queued", "provisioning", "connected", "ready", "terminating"],
      to: terminalState,
      reason,
      at,
      patch: {
        launchInput: null,
        registrationDigest: null,
        ...failurePatch,
      },
    });
  }

  async fail(row: WorkspaceRow, reason: ReasonCode, at: Date): Promise<void> {
    const action = row.templateSnapshot.spec.persistence.checkpoint.onFailure;
    if (
      action === "preserve" &&
      ["connected", "ready"].includes(row.state) &&
      (await this.requestPolicyPreserve(row, "failure"))
    ) {
      return;
    }
    await this.finalize(row, "failed", reason, at);
  }

  async handleProcessExit(row: WorkspaceRow, exitCode: number | null, at: Date): Promise<void> {
    if (
      exitCode === 0 &&
      row.templateSnapshot.spec.persistence.checkpoint.onCleanExit === "preserve" &&
      (await this.requestPolicyPreserve(row, "clean_exit"))
    ) {
      return;
    }
    if (exitCode !== 0) {
      await this.fail(row, "child_exit_failure", at);
      return;
    }
    await this.finalize(row, "succeeded", "child_exit_success", at);
  }

  async requestPolicyPreserve(
    row: WorkspaceRow,
    trigger: "idle" | "deadline" | "clean_exit" | "failure",
  ): Promise<boolean> {
    if (row.templateSnapshot.spec.persistence.mounts.length === 0 || !this.context.deps.preserveByPolicy) {
      return false;
    }
    try {
      return await this.context.deps.preserveByPolicy(row, trigger);
    } catch (error) {
      this.context.report(`preserve-policy.${trigger}.${row.id}`, error);
      return false;
    }
  }
}
