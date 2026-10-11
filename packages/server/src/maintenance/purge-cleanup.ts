import { ApiError } from "@pstdio/pocketcoder-contracts";
import type { AccountPurgeReader } from "@pstdio/pocketcoder-db/off-node";
import { cleanupWarmProvider, type Store, type WorkspaceDriver } from "@pstdio/pocketcoder-runtime-core";
import type { BuiltServer } from "../app";
import { completedDrainInventory, drainInventory } from "./account-compute-proof";
import type { Maintenance } from "./maintenance";
import { loadPurgeState, type PurgeState, savePurgeState, validatePurgeState } from "./purge-state";

type Runtime = Pick<BuiltServer, "scheduler" | "persistence" | "workspaceLeases" | "hub" | "controlActivity">;

export async function createPurgeCleanup(deps: {
  directory: string;
  read: AccountPurgeReader;
  store: Store;
  driver: WorkspaceDriver;
  maintenance: Maintenance;
  runtime: Runtime;
}) {
  const { directory, read, store, driver, maintenance, runtime } = deps;
  maintenance.settleWith(() => runtime.controlActivity.drain());
  let state = await loadPurgeState(directory);
  let running: Promise<ReturnType<typeof result>> | undefined;
  const result = () => ({
    account_id: read.accountId,
    mode: state ? "purging" : "ready",
    operation_id: state?.intent.operationId ?? null,
    operation_state: state?.state === "drained" ? "succeeded" : "pending",
    keys_revoked_at: state?.keysRevokedAt ?? null,
    ...(state?.compute ? { compute_proof: state.compute } : {}),
  });
  async function save(next: PurgeState) {
    await savePurgeState(directory, next);
    state = next;
  }
  async function intent() {
    const found = await read();
    if (found && (await read.completed())) throw new ApiError("account.purged", "Account purge is complete.");
    if (found) validatePurgeState(state, found);
    else if (state) throw new Error("Permanent purge authority is missing.");
    return found;
  }

  async function revokeKeys() {
    if (!state) throw new Error("Purge intent is missing.");
    if (state.keysRevokedAt) return;
    const at = new Date();
    for (const principal of await store.listPrincipals())
      if (!principal.disabledAt) await store.revokePrincipalKeys(principal.id, at);
    // A retry must acknowledge already enforced local revocations after an outage.
    await store.acknowledgeJournal?.();
    await save({ ...state, keysRevokedAt: at.toISOString() });
  }
  async function cancelWorkspaces() {
    for (const row of await store.listNonterminal()) {
      runtime.hub.close(row.id);
      const current =
        row.state === "preserving"
          ? await store.transition(row.id, {
              from: ["preserving"],
              to: "terminating",
              reason: "canceled_by_caller",
              at: new Date(),
              patch: { terminalIntent: "canceled" },
            })
          : row;
      if (current) await runtime.scheduler.finalize(current, "canceled", "canceled_by_caller", new Date());
    }
    await runtime.scheduler.drain();
    await runtime.persistence.drain();
  }
  async function drainWarm() {
    for (const row of await store.listWarmPoolRuntimes()) {
      if (row.state === "failed") continue;
      await store.updateWarmPoolRuntime(
        row.id,
        { state: "draining", enrollmentDigest: null, enrollmentExpiresAt: null },
        new Date(),
      );
      await cleanupWarmProvider(store, driver, row, new Date());
      await driver.cleanupWarmInput?.(row.id);
      await store.updateWarmPoolRuntime(row.id, { state: "failed", failureCode: "account_purged" }, new Date());
    }
  }
  async function revokeLeases() {
    for (const workspaceId of new Set((await store.listPendingWorkspaceLeases()).map((lease) => lease.workspaceId))) {
      if (!runtime.workspaceLeases) throw new Error("Workspace issuer is unavailable.");
      await runtime.workspaceLeases.revokeWorkspace(workspaceId);
    }
    if ((await store.listPendingWorkspaceLeases()).length) throw new Error("Workspace lease revocation is pending.");
  }
  async function zeroCompute() {
    if (
      (await store.listNonterminal()).length ||
      (await store.listWarmPoolRuntimes()).some((row) => row.state !== "failed")
    )
      throw new Error("Account runtime cleanup is pending.");
    if ((await driver.list()).length || (await driver.listWarm()).length) throw new Error("Account compute remains.");
  }
  async function run(id: string) {
    const found = await intent();
    if (!found || found.operationId !== id) throw new ApiError("operation.conflict", "Purge operation differs.");
    if (!state) await save({ intent: found, state: "purging" });
    maintenance.fence();
    runtime.controlActivity.fence();
    for (const row of await store.listNonterminal()) runtime.hub.close(row.id);
    await maintenance.drain();
    await revokeKeys();
    if (state?.state === "drained") return result();
    if (!state) throw new Error("Purge intent is missing.");
    await save({ ...state, compute: await drainInventory(state.compute, store) });
    await cancelWorkspaces();
    await drainWarm();
    await revokeLeases();
    await zeroCompute();
    const compute = await completedDrainInventory(state.compute, store);
    await store.acknowledgeJournal?.();
    await save({ ...state, state: "drained", compute });
    return result();
  }
  return {
    async status() {
      await intent();
      return result();
    },
    perform(id: string) {
      if (state && state.intent.operationId !== id)
        return Promise.reject(new ApiError("operation.conflict", "Purge operation differs."));
      running ??= run(id).finally(() => {
        running = undefined;
      });
      return running;
    },
    async drain() {
      await running?.catch(() => {});
    },
  };
}
export type PurgeCleanup = Awaited<ReturnType<typeof createPurgeCleanup>>;

export function configuredPurgeCleanup(
  initialized: { directory: string; accountPurge?: AccountPurgeReader; store: Store },
  driver: WorkspaceDriver,
  maintenance: Maintenance,
  runtime: Runtime,
) {
  if (!initialized.accountPurge) return undefined;
  return createPurgeCleanup({
    directory: initialized.directory,
    read: initialized.accountPurge,
    store: initialized.store,
    driver,
    maintenance,
    runtime,
  });
}
