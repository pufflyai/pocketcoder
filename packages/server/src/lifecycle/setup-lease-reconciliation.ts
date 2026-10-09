import type { Scheduler, Store } from "@pstdio/pocketcoder-runtime-core";
import type { createWorkspaceLeaseService } from "../secrets/lease-service";

export async function reconcileSetupLeases(
  store: Store,
  leases: ReturnType<typeof createWorkspaceLeaseService> | undefined,
  scheduler: Scheduler,
  startup = false,
) {
  if (!leases) return 0;
  const pending = await store.listPendingWorkspaceLeases();
  const cleanup = pending.filter(
    (row) => startup || row.state === "revoking" || (row.issuerExpiresAt !== null && row.issuerExpiresAt <= new Date()),
  );
  for (const id of new Set(cleanup.map((row) => row.workspaceId))) {
    const workspace = await store.getWorkspace(id);
    if (!workspace) throw new Error("Lease workspace is unavailable.");
    try {
      // The preserve operation owns capture and removal of its source bytes.
      if (workspace.state !== "preserving" && (startup || (await store.hasWorkspaceLeaseFence(id)))) {
        await scheduler.finalize(
          workspace,
          workspace.terminalIntent ?? "failed",
          "secret_resolution_failed",
          new Date(),
        );
      } else {
        for (const row of cleanup.filter((row) => row.workspaceId === id)) await leases.revoke(row.id);
      }
    } catch {
      // The durable request remains owned and will retry on the next tick.
    }
  }
  return (await store.listPendingWorkspaceLeases()).filter((row) => row.state === "revoking").length;
}
