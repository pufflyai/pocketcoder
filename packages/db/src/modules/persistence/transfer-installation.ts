import { canonicalJson } from "@pstdio/pocketcoder-contracts";
import type { CheckpointTransferRow } from "@pstdio/pocketcoder-runtime-contracts";
import { eq } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";

export async function completeCheckpointStorage(
  context: DatabaseContext,
  tx: Transaction,
  row: CheckpointTransferRow,
  at: Date,
) {
  const { workspaceStorage: storage, workspaces } = context.tables;
  const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, row.workspaceId));
  const [owned] = await tx.select().from(storage).where(eq(storage.workspaceId, row.workspaceId)).for("update");
  if (
    !workspace ||
    !owned ||
    owned.state !== "restoring" ||
    owned.deletedAt ||
    owned.principalId !== row.principalId ||
    canonicalJson(owned.mountManifest) !== canonicalJson(workspace.templateSnapshot.spec.persistence.mounts) ||
    !row.summary
  )
    throw new Error("Checkpoint destination storage authority changed.");
  await tx
    .update(storage)
    .set({
      state: "ready",
      logicalBytes: row.summary.mounts.reduce((total, mount) => total + mount.logical_bytes, 0),
      fileCount: row.summary.mounts.reduce((total, mount) => total + mount.file_count, 0),
      updatedAt: at,
    })
    .where(eq(storage.id, owned.id));
}
