import { snapshotServices } from "@pstdio/pocketcoder-contracts";
import type { WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
import { setupAuthorityClosed } from "./setup-authority";
import type { WsDeps } from "./ws-types";

function requiredServicesHealthy(row: WorkspaceRow, health: Record<string, string>) {
  const template = row.runtimeRegistration?.template?.manifest;
  const agentServices = new Set(
    Object.values(template?.spec.adapters ?? {})
      .filter((adapter) => adapter.kind === "pi" || adapter.kind === "agentapi")
      .map((adapter) => adapter.service),
  );
  return Object.entries(template?.spec.services ?? snapshotServices(row.templateSnapshot))
    .filter(([name, service]) => service.required && !agentServices.has(name))
    .every(([name]) => health[name] === "healthy");
}

function runtimePrepared(row: WorkspaceRow) {
  const runtime = row.runtimeRegistration;
  return !runtime || (runtime.readyAt && !runtime.endedAt);
}

export async function maybeMarkReady(
  deps: WsDeps,
  row: WorkspaceRow,
  health: Record<string, string>,
  networkState: WorkspaceRow["networkState"],
) {
  if (!runtimePrepared(row)) return;
  if (row.state !== "connected" || !(await setupAuthorityClosed(deps.store, row))) return;
  const connection = deps.hub.get(row.id);
  if (deps.checkpointTransfers && row.launchMode === "restore") {
    if (!connection?.restoreInstalled || !connection.harnessRunning) return;
  }
  if (!requiredServicesHealthy(row, health)) return;
  const network = row.runtimeRegistration?.template?.manifest.spec.network ?? row.templateSnapshot.spec.network;
  if (network.mode === "restricted" && networkState !== "ready") return;
  const now = new Date();
  if (row.sourceDescriptor && !row.resolvedSource) {
    await deps.scheduler.finalize(row, "failed", "source_resolution_failed", now);
    return;
  }
  if (deps.checkpointTransfers && row.launchMode === "restore" && connection) {
    try {
      if (await deps.checkpointTransfers.ready(connection)) return;
      throw new Error("Restore readiness did not settle.");
    } catch (error) {
      deps.log?.(`restore ${row.id}: ${String(error)}`);
      await deps.checkpointTransfers.disconnected?.(connection);
      deps.hub.close(row.id);
      await deps.scheduler.beginTermination(row, "failed", "restore_failed", now);
      return;
    }
  }
  await deps.store.transition(row.id, {
    from: ["connected"],
    to: "ready",
    at: now,
    patch: { readyAt: now, lastActivityAt: now, launchInput: null },
  });
}
