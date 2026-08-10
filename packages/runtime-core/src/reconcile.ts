import { parseDurationMs } from "@pstdio/pocketcoder-contracts";
import type { StorageRef, WorkspaceDriver, WorkspaceStorageDriver } from "./driver";
import type { MetricSink } from "./metrics";
import { measureReconciliation } from "./reconciliation-metrics";
import type { Store, WorkspaceRow } from "./types";

// Server-restart recovery: reconcile PostgreSQL state with provider objects.
// Workspaces with a live provider wait for their supervisor to reconnect
// inside the disconnect grace; workspaces whose provider vanished fail.

export interface ReconcileDeps {
  store: Store;
  driver: WorkspaceDriver;
  storageDriver?: WorkspaceStorageDriver;
  now?: () => Date;
  log?: (msg: string) => void;
  metrics?: MetricSink;
}

async function reconcileProviderRow(
  deps: ReconcileDeps,
  row: WorkspaceRow,
  found: Awaited<ReturnType<WorkspaceDriver["list"]>>[number] | undefined,
  now: Date,
): Promise<void> {
  if (row.state === "queued") return;
  const mismatched = found && found.templateDigest !== row.templateDigest;
  if (mismatched) {
    deps.log?.(`reconcile: template digest mismatch for ${row.id}; failing workspace`);
  }
  const lost = !found || mismatched;
  if (lost && row.state === "terminating") {
    // The provider is gone and termination was already requested; honor
    // the recorded intent (e.g. canceled) instead of failing.
    await deps.store.transition(row.id, {
      from: ["terminating"],
      to: row.terminalIntent ?? "failed",
      reason: row.reasonCode ?? "provider_lost",
      at: now,
    });
    return;
  }
  if (lost && (row.state === "connected" || row.state === "ready")) {
    await settleLostStorage(deps, row, now);
    await deps.store.transition(row.id, {
      from: [row.state],
      to: "failed",
      reason: "provider_lost",
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
      deps.log?.(
        `reconcile: unknown provider object for workspace ${found.workspaceId}; leaving for inspection`,
      );
    }
  }

  for (const row of rows) {
    await reconcileProviderRow(deps, row, byWorkspace.get(row.id), now);
  }
}

export async function reconcileProviders(deps: ReconcileDeps): Promise<void> {
  await measureReconciliation(deps.metrics, "provider", false, () => reconcileProviderState(deps));
}

async function settleLostStorage(deps: ReconcileDeps, row: WorkspaceRow, now: Date): Promise<void> {
  if (!deps.storageDriver) return;
  const storage = await deps.store.getWorkspaceStorage(row.id);
  if (!storage || ["deleted", "retained"].includes(storage.state)) return;
  const failurePolicy = row.templateSnapshot.spec.persistence.checkpoint.onFailure;
  if (failurePolicy !== "destroy") {
    await deps.store.updateWorkspaceStorage(
      storage.id,
      {
        state: "retained",
        retainedUntil: new Date(
          now.getTime() +
            parseDurationMs(row.templateSnapshot.spec.persistence.checkpoint.retention),
        ),
        lastErrorCode: "provider_lost",
      },
      now,
    );
    return;
  }
  try {
    if (Object.keys(storage.providerRef).length > 0) {
      await deps.storageDriver.deleteStorage(storage.providerRef as StorageRef);
    }
    await deps.store.updateWorkspaceStorage(storage.id, { state: "deleted", deletedAt: now }, now);
  } catch {
    await deps.store.updateWorkspaceStorage(
      storage.id,
      { lastErrorCode: "storage_cleanup_failed" },
      now,
    );
  }
}
