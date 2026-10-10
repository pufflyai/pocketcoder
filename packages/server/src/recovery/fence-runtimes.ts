import type { ProviderRef, WorkspaceDriver } from "@pstdio/pocketcoder-runtime-core";
import type { BuiltServer } from "../app";
import type { RecoveryDeps } from "./complete-recovery";

// Removes a runtime the restored database does not know, but the journal says this controller purged.
export async function removeRuntime(driver: WorkspaceDriver, workspaceId: string) {
  for (const found of await driver.list())
    if (found.workspaceId === workspaceId) {
      await driver.stop(found.ref, 0);
      await driver.remove(found.ref);
    }
  await driver.purgeInput(workspaceId);
}

// Runtimes, sessions and grants in a restored database belong to the old controller.
// Their workspaces fail, their providers are removed and their issuer leases are revoked.
export async function fenceRuntimes(
  { store, driver }: RecoveryDeps,
  { scheduler, workspaceLeases }: Pick<BuiltServer, "scheduler" | "workspaceLeases">,
) {
  const at = new Date();
  const active = await store.listNonterminal();
  for (const row of active) {
    // The old controller may have launched a queued workspace after the backup.
    if (row.state === "queued") {
      await store.transition(row.id, { from: ["queued"], to: "canceled", reason: "provider_lost", at });
      await removeRuntime(driver, row.id);
      continue;
    }
    const current =
      row.state === "preserving"
        ? await store.transition(row.id, {
            from: ["preserving"],
            to: "terminating",
            reason: "provider_lost",
            at,
            patch: { terminalIntent: "failed" },
          })
        : row;
    if (current) await scheduler.finalize(current, "failed", "provider_lost", at);
  }
  await scheduler.drain();
  const remaining = await store.listNonterminal();
  if (remaining.length) throw new Error(`${remaining.length} restored workspaces still have runtimes. Retry recovery.`);

  for (const runtime of await store.listWarmPoolRuntimes()) {
    if (runtime.state === "failed") continue;
    if (runtime.providerRef) {
      const ref = runtime.providerRef as ProviderRef;
      await driver.stop(ref, 0);
      await driver.remove(ref);
    }
    await driver.cleanupWarmInput?.(runtime.id);
    await store.updateWarmPoolRuntime(
      runtime.id,
      { state: "failed", enrollmentDigest: null, enrollmentExpiresAt: null, failureCode: "controller_restored" },
      at,
    );
  }

  // Preserved and finished workspaces can still hold issuer leases.
  const leased = new Set((await store.listPendingWorkspaceLeases()).map((lease) => lease.workspaceId));
  for (const workspaceId of leased) {
    if (!workspaceLeases) throw new Error("Restored workspace leases need the controller secret key.");
    await workspaceLeases.revokeWorkspace(workspaceId);
  }

  // Runtimes created after the backup are not ours to remove. They cannot reconnect to this
  // database, and their short-lived leases expire on their own.
  const known = new Set(active.map((row) => row.id));
  const unknown = (await driver.list()).filter((found) => !known.has(found.workspaceId)).length;
  return { workspaces: active.length, leasedWorkspaces: leased.size, unknownRuntimes: unknown };
}
