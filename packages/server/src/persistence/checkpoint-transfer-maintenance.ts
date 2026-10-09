import { createHash } from "node:crypto";
import { openCheckpointArchivePublication } from "@pstdio/pocketcoder-db/checkpoints";
import type { Store, WorkspaceCheckpointRow } from "@pstdio/pocketcoder-runtime-core";
import type { TransferLifetime } from "./checkpoint-transfer-lifetime";

export function createCheckpointTransferMaintenance(store: Store, lifetime: TransferLifetime, directory: string) {
  async function publication(checkpoint: WorkspaceCheckpointRow) {
    const row = await store.checkpointTransfers.publication(checkpoint.id);
    if (
      !row?.stagePath ||
      !row.stageIdentity ||
      row.principalId !== checkpoint.principalId ||
      row.workspaceId !== checkpoint.workspaceId ||
      checkpoint.providerRef?.archivePath !== row.stagePath ||
      checkpoint.providerRef?.transferId !== row.id ||
      row.archiveDigest === null ||
      row.storedBytes !== checkpoint.storedBytes
    )
      throw new Error("Checkpoint publication metadata differs from its catalog.");
    return row;
  }
  return {
    async verify(checkpoint: WorkspaceCheckpointRow) {
      const row = await publication(checkpoint);
      const owner = openCheckpointArchivePublication(
        directory,
        row.stagePath as string,
        row.stageIdentity as NonNullable<typeof row.stageIdentity>,
        () => {},
      );
      const reader = owner.stream().getReader();
      const hash = createHash("sha256");
      let bytes = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.length;
          hash.update(part.value);
        }
        owner.validate();
        if (bytes !== row.storedBytes || `sha256:${hash.digest("hex")}` !== row.archiveDigest)
          throw new Error("Checkpoint archive content differs from its publication receipt.");
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        await owner.close();
      }
    },
    async delete(checkpoint: WorkspaceCheckpointRow) {
      const row = await publication(checkpoint);
      const contexts = [...lifetime.active.values()].filter((context) => context.row.checkpointId === checkpoint.id);
      for (const context of contexts) await lifetime.cleanup(context);
      const owner = openCheckpointArchivePublication(
        directory,
        row.stagePath as string,
        row.stageIdentity as NonNullable<typeof row.stageIdentity>,
        () => {},
      );
      let removed = false;
      try {
        await store.checkpointTransfers.removePublication(row.id, () => {
          if (!removed) {
            owner.remove();
            removed = true;
          }
          owner.checkRemoved();
        });
      } finally {
        await owner.close();
      }
    },
  };
}
