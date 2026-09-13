import { parseDurationMs, type ReasonCode, type WorkspaceState } from "@pstdio/pocketcoder-contracts";
import type { WorkspacePatch, WorkspaceRow } from "../types";
import { decodeFailureLogTail, FAILURE_LOG_TAIL_BYTES, type SchedulerContext } from "./scheduler-base";

export class SchedulerLifecycle {
  constructor(private readonly context: SchedulerContext) {}
  async beginTermination(
    row: WorkspaceRow,
    terminalState: WorkspaceState,
    reason: ReasonCode,
    at: Date,
  ): Promise<WorkspaceRow | null> {
    const { store, connections } = this.context.deps;
    const updated = await store.transition(row.id, {
      from: ["provisioning", "connected", "ready"],
      to: "terminating",
      reason,
      at,
      patch: { terminalIntent: terminalState },
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
      this.stopAndRemove(
        { kind: updated.providerKind ?? "", id: "", ...updated.providerRef },
        this.context.graceSeconds(updated),
      )
        .then(() => this.finalize(updated, terminalState, reason, this.context.now()))
        .catch((err) => this.context.report(`terminate.${row.id}`, err));
    } else {
      await this.finalize(updated, terminalState, reason, at);
    }
    return updated;
  }

  async finalize(
    row: WorkspaceRow,
    terminalState: WorkspaceState,
    reason: ReasonCode | null,
    at: Date,
    retainStorage = false,
  ): Promise<void> {
    const { store, driver, connections } = this.context.deps;
    if (row.providerRef) {
      try {
        await driver.stop({ kind: row.providerKind ?? "", id: "", ...row.providerRef }, this.context.graceSeconds(row));
        await driver.remove({
          kind: row.providerKind ?? "",
          id: "",
          ...row.providerRef,
        });
      } catch (err) {
        this.context.report(`finalize.terminate.${row.id}`, err);
      }
    }
    if (retainStorage) {
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

  async stopAndRemove(ref: { kind: string; id: string; [key: string]: unknown }, graceSeconds: number): Promise<void> {
    await this.context.deps.driver.stop(ref, graceSeconds);
    await this.context.deps.driver.remove(ref);
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
    await this.finalize(row, "failed", reason, at, action === "retain-for-recovery");
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
