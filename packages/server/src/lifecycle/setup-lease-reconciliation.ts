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
  // Setup authority is one-shot: after a restart its interrupted setup cannot resume. A delivered
  // runtime credential stays valid across the restart and the reconnecting workspace keeps it.
  const interrupted = (row: (typeof pending)[number]) => startup && row.purpose === "setup-issuer";
  const cleanup = pending.filter(
    (row) =>
      interrupted(row) ||
      row.state === "revoking" ||
      (row.issuerExpiresAt !== null && row.issuerExpiresAt <= new Date()),
  );
  for (const id of new Set(cleanup.map((row) => row.workspaceId))) {
    const workspace = await store.getWorkspace(id);
    if (!workspace) throw new Error("Lease workspace is unavailable.");
    try {
      // The preserve operation owns capture and removal of its source bytes.
      const setup = cleanup.some((row) => row.workspaceId === id && interrupted(row));
      if (workspace.state !== "preserving" && (setup || (await store.hasWorkspaceLeaseFence(id)))) {
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
