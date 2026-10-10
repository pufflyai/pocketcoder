import type { WorkspaceDriver, WorkspaceStorageDriver } from "../driver";
import type { MetricSink } from "../observability/metrics";
import type { Store, WorkspaceRow } from "../types";
import { measureReconciliation } from "./reconciliation-metrics";

// Server-restart recovery: reconcile database state with provider objects.
// Workspaces with a live provider wait for their supervisor to reconnect
// inside the disconnect grace; missing providers wait for proven cleanup before failure.

export interface ReconcileDeps {
  store: Store;
  driver: WorkspaceDriver;
  storageDriver?: WorkspaceStorageDriver;
  now?: () => Date;
  log?: (msg: string) => void;
  metrics?: MetricSink;
}

export async function reconcileProviderRow(
  deps: Pick<ReconcileDeps, "store" | "storageDriver" | "log">,
  row: WorkspaceRow,
  found: Awaited<ReturnType<WorkspaceDriver["list"]>>[number] | undefined,
  now: Date,
): Promise<void> {
  // A missing provider does not prove its secrets and storage were cleaned up.
  // Let the scheduler finish termination, including after a partial removal.
  if (row.state === "queued" || row.state === "terminating") return;
  const mismatched = found && found.templateDigest !== row.templateDigest;
  if (mismatched) {
    deps.log?.(`reconcile: template digest mismatch for ${row.id}; failing workspace`);
  }
  const lost = !found || mismatched;
  if (lost && (row.state === "connected" || row.state === "ready")) {
    await deps.store.transition(row.id, {
      from: [row.state],
      to: "terminating",
      reason: "provider_lost",
      patch: { terminalIntent: "failed" },
      at: now,
    });
    return;
  }
  const connected = row.state === "connected" || row.state === "ready";
  if (connected && !row.disconnectedAt) {
    // The old connection died with the previous server process; start the
    // reconnect grace now.
    await deps.store.updateWorkspace(row.id, { disconnectedAt: now }, now);
  }
}

async function reconcileProviderState(deps: ReconcileDeps): Promise<void> {
  const now = deps.now ? deps.now() : new Date();
  const rows = await deps.store.listNonterminal();
  const discovered = await deps.driver.list();
  const byWorkspace = new Map(discovered.map((d) => [d.workspaceId, d]));
  const known = new Set(rows.map((r) => r.id));

  for (const found of discovered) {
    if (!known.has(found.workspaceId)) {
      // Unknown objects are never adopted; they are quarantined for the
      // operator and logged loudly.
      deps.log?.(`reconcile: unknown provider object for workspace ${found.workspaceId}; leaving for inspection`);
    }
  }

  for (const row of rows) {
    await reconcileProviderRow(deps, row, byWorkspace.get(row.id), now);
  }
}

export async function reconcileProviders(deps: ReconcileDeps): Promise<void> {
  await measureReconciliation(deps.metrics, "provider", false, () => reconcileProviderState(deps));
}
