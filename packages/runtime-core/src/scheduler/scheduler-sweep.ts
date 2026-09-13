import type { WorkspaceState } from "@pstdio/pocketcoder-contracts";

import type { WorkspaceRow } from "../types";

import type { SchedulerContext } from "./scheduler-base";
import type { SchedulerLifecycle } from "./scheduler-lifecycle";

export class SchedulerSweep {
  constructor(
    private readonly context: SchedulerContext,
    private readonly lifecycle: SchedulerLifecycle,
  ) {}
  async sweep(): Promise<void> {
    const now = this.context.now();
    let rows: WorkspaceRow[];
    try {
      rows = await this.context.deps.store.listNonterminal();
    } catch (err) {
      this.context.report("sweep.list", err);
      return;
    }
    for (const row of rows) {
      try {
        await this.sweepRow(row, now);
      } catch (err) {
        this.context.report(`sweep.${row.id}`, err);
      }
    }
  }

  async sweepQueued(row: WorkspaceRow, now: Date): Promise<void> {
    const queueAge = now.getTime() - row.createdAt.getTime();
    if (queueAge > this.context.deps.limits.maxQueueAgeMs) {
      await this.context.deps.store.transition(row.id, {
        from: ["queued"],
        to: "expired",
        reason: "queue_timeout",
        at: now,
      });
      return;
    }
    if (now >= row.deadlineAt) {
      await this.context.deps.store.transition(row.id, {
        from: ["queued"],
        to: "expired",
        reason: "deadline_expired",
        at: now,
      });
    }
  }

  async sweepActive(row: WorkspaceRow, now: Date): Promise<void> {
    if (now >= row.deadlineAt) {
      const preserve =
        row.templateSnapshot.spec.persistence.checkpoint.onDeadline === "preserve" &&
        (await this.lifecycle.requestPolicyPreserve(row, "deadline"));
      if (!preserve) {
        await this.lifecycle.beginTermination(row, "expired", "deadline_expired", now);
      }
      return;
    }
    const idle =
      row.state === "ready" &&
      row.lastActivityAt !== null &&
      now.getTime() - row.lastActivityAt.getTime() > this.context.timeoutMs(row, "idle");
    if (idle) {
      const preserve =
        row.templateSnapshot.spec.persistence.checkpoint.onIdle === "preserve" &&
        (await this.lifecycle.requestPolicyPreserve(row, "idle"));
      if (!preserve) {
        await this.lifecycle.beginTermination(row, "expired", "idle_expired", now);
      }
      return;
    }
    const disconnectedTooLong =
      row.disconnectedAt !== null &&
      !this.context.deps.connections.isConnected(row.id) &&
      now.getTime() - row.disconnectedAt.getTime() > this.context.timeoutMs(row, "disconnectGrace");
    if (disconnectedTooLong) await this.lifecycle.fail(row, "disconnect_timeout", now);
  }

  async sweepTerminating(row: WorkspaceRow, now: Date): Promise<void> {
    // Enforce with the provider if the agent has not exited within a few
    // grace periods.
    const stuckMs = 4 * this.context.timeoutMs(row, "terminateGrace") + 5000;
    if (now.getTime() - row.updatedAt.getTime() <= stuckMs) return;
    await this.lifecycle.finalize(row, (row.terminalIntent ?? "failed") as WorkspaceState, row.reasonCode, now);
  }

  async sweepRow(row: WorkspaceRow, now: Date): Promise<void> {
    switch (row.state) {
      case "queued":
        await this.sweepQueued(row, now);
        return;
      case "provisioning":
        if (row.registrationExpiresAt && now >= row.registrationExpiresAt) {
          if (row.provisioningMode === "warm" && row.launchAttempts < this.context.deps.limits.maxLaunchAttempts) {
            if (row.providerRef) {
              await this.context.deps.driver.stop(row.providerRef as never, 1).catch(() => {});
              await this.context.deps.driver.remove(row.providerRef as never).catch(() => {});
            }
            await this.context.deps.store.transition(row.id, {
              from: ["provisioning"],
              to: "queued",
              at: now,
              patch: {
                providerKind: null,
                providerRef: null,
                provisioningMode: null,
                registrationDigest: null,
                registrationExpiresAt: null,
              },
            });
          } else {
            await this.lifecycle.fail(row, "registration_timeout", now);
          }
        }
        return;
      case "connected":
      case "ready":
        await this.sweepActive(row, now);
        return;
      case "terminating":
        await this.sweepTerminating(row, now);
        return;
      case "preserving":
        return;
    }
  }
}
