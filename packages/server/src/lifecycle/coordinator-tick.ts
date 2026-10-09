import type { Store } from "@pstdio/pocketcoder-runtime-core";
import type { buildServer } from "../app";
import type { Readiness } from "../observability/health";
import { reconcileCheckpointPreserves } from "./lifecycle-resources";
import { reconcileSetupLeases } from "./setup-lease-reconciliation";

type Coordinator = Pick<
  ReturnType<typeof buildServer>,
  "scheduler" | "persistence" | "workspaceLeases" | "checkpointTransfers" | "metrics"
> & { store: Store; readiness: Readiness };

export function createCoordinatorTick(deps: Coordinator) {
  const { store, scheduler, persistence, workspaceLeases, checkpointTransfers, readiness, metrics } = deps;
  return async () => {
    try {
      await scheduler.tick();
      const leases = await reconcileSetupLeases(store, workspaceLeases, scheduler);
      const transfers = await reconcileCheckpointPreserves(
        store,
        persistence.reconcileCheckpointOperation,
        checkpointTransfers,
      );
      const preserves = await persistence.retryPreserves();
      const purges = await persistence.retryPurges();
      readiness.set("cleanup", purges + leases + preserves + transfers > 0 ? "pending" : "ok");
      metrics.observe("purge.pending", purges);
      readiness.set("coordinator", "ok");
    } catch (error) {
      readiness.set("coordinator", "failed");
      throw error;
    }
  };
}
