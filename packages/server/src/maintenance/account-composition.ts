import type { RuntimeMetrics } from "@pstdio/pocketcoder-runtime-core";
import { reconcileCheckpointPreserves, reconcileStartup } from "../lifecycle/lifecycle-resources";
import { reconcileSetupLeases } from "../lifecycle/setup-lease-reconciliation";
import type { Readiness } from "../observability/health";
import { createAccountLifecycle } from "./account-lifecycle";

type AccountDeps = Omit<Parameters<typeof createAccountLifecycle>[0], "reconcileData" | "driver" | "storageDriver"> & {
  driver: Parameters<typeof reconcileStartup>[1];
  storageDriver: Parameters<typeof reconcileStartup>[2];
  log: (message: string) => void;
  metrics: RuntimeMetrics;
  readiness: Readiness;
};
export function composeAccountLifecycle(deps: AccountDeps) {
  const { store, driver, storageDriver, log, metrics, readiness } = deps;
  const { scheduler, persistence, workspaceLeases, checkpointTransfers } = deps.runtime;
  return createAccountLifecycle({
    ...deps,
    async reconcileData() {
      const setup = await reconcileSetupLeases(store, workspaceLeases, scheduler, true);
      const transfers = await reconcileCheckpointPreserves(
        store,
        persistence.reconcileCheckpointOperation,
        checkpointTransfers,
        true,
      );
      const reconciled = await reconcileStartup(
        store,
        driver,
        storageDriver,
        log,
        metrics,
        persistence.reconcileCheckpointOperation,
      );
      if (setup + transfers > 0 || !reconciled) throw new Error("Account data and authority reconciliation is pending");
      readiness.set("cleanup", "ok");
      readiness.set("reconciliation", "ok");
    },
  });
}
