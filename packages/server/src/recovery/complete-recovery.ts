import { randomUUID } from "node:crypto";
import type { PGliteStore } from "@pstdio/pocketcoder-db";
import {
  reconcilePersistence,
  type WorkspaceDriver,
  type WorkspaceStorageDriver,
} from "@pstdio/pocketcoder-runtime-core";
import type { BuiltServer } from "../app";
import { reconcileCheckpointPreserves } from "../lifecycle/lifecycle-resources";
import { fenceRuntimes, removeRuntime } from "./fence-runtimes";

export interface RecoveryDeps {
  store: PGliteStore;
  driver: WorkspaceDriver;
  storageDriver?: WorkspaceStorageDriver;
}
type Runtime = Pick<BuiltServer, "scheduler" | "persistence" | "workspaceLeases" | "checkpointTransfers">;
type Event = Awaited<ReturnType<PGliteStore["recovery"]["recoveryEvents"]>>[number];
type Keys = { recovery: string; attempt: string };

// Keys belong to this recovery: an old receipt in the restored database cannot prove that
// restored bytes are gone, so each purge and deletion runs again. A purge that succeeded
// earlier in the same recovery ran after the restore and stands; a failed deletion retries
// under a new attempt key.
async function replayDeletion(deps: RecoveryDeps, runtime: Runtime, event: Event, keys: Keys) {
  const { store } = deps;
  if (event.kind === "workspace_purged") {
    const principal = await store.getPrincipal(event.principalId);
    if (!principal || !(await store.getWorkspace(event.workspaceId)))
      return removeRuntime(deps.driver, event.workspaceId);
    const operation = await runtime.persistence.purge(
      principal,
      event.workspaceId,
      `${keys.recovery}:${event.workspaceId}`,
    );
    await runtime.persistence.drain();
    const settled = await store.getOperation(operation.id);
    if (settled?.state !== "succeeded")
      throw new Error(`Purge of workspace ${event.workspaceId} did not finish (${settled?.reasonCode ?? "pending"}).`);
  }
  if (event.kind === "checkpoint_deleted") {
    const principal = await store.getPrincipal(event.principalId);
    const checkpoint = await store.getCheckpoint(event.checkpointId);
    if (!principal || !checkpoint || checkpoint.state === "deleted") return;
    const operation = await runtime.persistence.delete(
      principal,
      event.checkpointId,
      `${keys.attempt}:${event.checkpointId}`,
    );
    if (operation.state !== "succeeded")
      throw new Error(`Deletion of checkpoint ${event.checkpointId} did not finish.`);
  }
}

// Replays the journal into the restored database, fences the old controller's runtimes
// and grants, then moves the journal's writer claim here. Every step can run again.
export async function completeRecovery(deps: RecoveryDeps, runtime: Runtime) {
  const recovery = await deps.store.recovery.recoveryState();
  if (!recovery) throw new Error("This controller is not in recovery.");
  const events = await deps.store.recovery.recoveryEvents();
  for (const event of events) await deps.store.recovery.applyRecord(event);
  const fenced = await fenceRuntimes(deps, runtime);
  // Settle the old controller's unfinished operations the way a normal start would.
  const { store, driver, storageDriver } = deps;
  const reconcileCheckpointOperation = runtime.persistence.reconcileCheckpointOperation;
  await reconcileCheckpointPreserves(store, reconcileCheckpointOperation, runtime.checkpointTransfers, true);
  await reconcilePersistence({ store, driver, storageDriver, reconcileCheckpointOperation });
  // Purges left unfinished by the backup or an interrupted attempt resume first.
  await runtime.persistence.retryPurges();
  const keys = {
    recovery: `recovery:${recovery.recoveryId}`,
    attempt: `recovery:${recovery.recoveryId}:${randomUUID()}`,
  };
  for (const event of events) await replayDeletion(deps, runtime, event, keys);
  await deps.store.recovery.finishRecovery(recovery.recoveryId);
  return { recoveryId: recovery.recoveryId, events: events.length, ...fenced };
}
