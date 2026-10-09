import { removeInterruptedCheckpointPublication } from "@pstdio/pocketcoder-db/checkpoints";
import type { Store, WorkspaceCheckpointRow } from "@pstdio/pocketcoder-runtime-core";
import type { TransferLifetime } from "./checkpoint-transfer-lifetime";

export function createCheckpointTransferRecovery(
  store: Store,
  lifetime: TransferLifetime,
  directory: string,
  verify: (checkpoint: WorkspaceCheckpointRow) => Promise<void>,
) {
  async function verifyPublication(checkpointId: string) {
    const checkpoint = await store.getCheckpoint(checkpointId);
    if (checkpoint?.state !== "ready") return;
    try {
      await verify(checkpoint);
    } catch {
      await store.updateCheckpoint(checkpoint.id, { state: "failed", reasonCode: "checkpoint_corrupt" }, new Date());
    }
  }
  return async function reconcile(verifyComplete = true) {
    let pending = 0;
    for (const row of await store.checkpointTransfers.listUnsettled()) {
      if (lifetime.active.has(row.id)) continue;
      if (row.state === "complete") {
        if (verifyComplete && row.direction === "upload") await verifyPublication(row.checkpointId);
        continue;
      }
      try {
        // Anonymous spool/index files disappear with the process. Only named publication files need custody proof.
        const checkRemoved =
          row.direction === "upload"
            ? removeInterruptedCheckpointPublication(directory, `${row.checkpointId}-${row.id}.tar`, row.stageIdentity)
            : () => {};
        await store.checkpointTransfers.abort(row.id, checkRemoved);
      } catch {
        pending += 1;
      }
    }
    return pending;
  };
}
