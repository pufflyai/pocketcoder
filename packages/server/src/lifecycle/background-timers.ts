import type { OutboxDispatcher, WarmPoolManager } from "@pstdio/pocketcoder-runtime-core";
import type { ServerConfig } from "../config/config";
import type { Maintenance } from "../maintenance/maintenance";
import { createCoordinatorTick } from "./coordinator-tick";
import type { ServerLog } from "./lifecycle";
import { startExclusiveTimer } from "./lifecycle-resources";
import type { loadPolicyReconciliation } from "./policy-reconciliation";

// Every background tick pauses during a maintenance window and catches up after it.
export function startBackgroundTimers(
  deps: Parameters<typeof createCoordinatorTick>[0] & {
    config: ServerConfig;
    maintenance: Maintenance;
    log: ServerLog;
    outbox: OutboxDispatcher;
    policyReconciliation: ReturnType<typeof loadPolicyReconciliation>;
    warmPool?: WarmPoolManager;
  },
) {
  const { config, maintenance, log, outbox, policyReconciliation, warmPool, readiness, persistence } = deps;
  const start = (intervalMs: number, task: () => Promise<void>, errorContext: string) =>
    startExclusiveTimer(intervalMs, maintenance.pausable(task), errorContext, log);
  const timers = [
    start(config.schedulerIntervalMs, createCoordinatorTick(deps), "scheduler tick failed"),
    start(config.outboxIntervalMs, () => outbox.tick(), "outbox tick failed"),
    start(
      60_000,
      async () => {
        await deps.store.binaryOutputs.prune(new Date());
        const { deleted, skipped } = await persistence.pruneExpired();
        if (deleted > 0 || skipped > 0) log(`retention: deleted=${deleted} skipped=${skipped}`);
      },
      "retention sweep failed",
    ),
  ];
  if (policyReconciliation)
    timers.push(
      start(
        config.schedulerIntervalMs,
        async () => {
          try {
            await policyReconciliation.tick();
            readiness.set("policy-reconciliation", "ok");
          } catch (error) {
            readiness.set("policy-reconciliation", "failed");
            throw error;
          }
        },
        "policy reconciliation failed",
      ),
    );
  if (warmPool)
    timers.push(start(config.schedulerIntervalMs, () => warmPool.reconcile(), "warm pool reconciliation failed"));
  return {
    async stop() {
      for (const timer of timers) clearInterval(timer);
      await policyReconciliation?.drain();
    },
  };
}
