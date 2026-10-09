import { CheckpointArchiveSummarySchema, canonicalJson } from "@pstdio/pocketcoder-contracts";
import type {
  CheckpointPublication,
  CheckpointRetentionLimits,
  CheckpointTransferRow,
} from "@pstdio/pocketcoder-runtime-contracts";
import { eq } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { requiredRow } from "../../database/required-row";
import { checkpointDownloadAuthority } from "./download-authority";
import { lockStorageCapacity } from "./reservation-capacity";
import { checkpointUploadAuthority, checkpointUploadReservation, transferDeadline } from "./transfer-authority";
import { completeCheckpointStorage } from "./transfer-installation";
import { assertCheckpointRetention } from "./transfer-retention";
import { createCheckpointRestoreSettlement } from "./transfer-settlement";

async function active(context: DatabaseContext, tx: Transaction, id: string, check: () => void) {
  check();
  context.validateStorage?.();
  const [found] = await tx
    .select()
    .from(context.tables.checkpointTransfers)
    .where(eq(context.tables.checkpointTransfers.id, id))
    .for("update");
  const row = requiredRow(found);
  if (!["granted", "streaming", "validated"].includes(row.state)) throw new Error("Checkpoint transfer is not active.");
  const authority =
    row.direction === "upload"
      ? await checkpointUploadAuthority(context, tx, row, check)
      : await checkpointDownloadAuthority(context, tx, row, check);
  if (row.principalId !== authority.workspace.principalId)
    throw new Error("Checkpoint transfer principal authority changed.");
  if (row.direction === "upload") await checkpointUploadReservation(context, tx, row, check);
  else if (
    "publication" in authority &&
    (row.archiveDigest !== authority.publication.archiveDigest ||
      row.storedBytes !== authority.publication.storedBytes ||
      row.expectedArchiveBytes !== authority.publication.storedBytes ||
      canonicalJson(row.declaredHeader) !== canonicalJson(authority.publication.declaredHeader) ||
      canonicalJson(row.summary) !== canonicalJson(authority.publication.summary))
  )
    throw new Error("Checkpoint download publication binding changed.");
  transferDeadline(row.expiresAt, check);
  return row;
}

export function createCheckpointTransferLifecycle(context: DatabaseContext) {
  const {
    db,
    tables: { checkpointTransfers: transfers, storageReservations: reservations, workspaceCheckpoints: checkpoints },
  } = context;
  async function transaction<T>(action: (tx: Transaction) => Promise<T>) {
    return db.transaction(async (tx) => {
      await lockStorageCapacity(context, tx);
      return action(tx);
    });
  }
  return {
    completeRestore: createCheckpointRestoreSettlement(context),
    validate(id: string, check: () => void) {
      return transaction((tx) => active(context, tx, id, check));
    },
    publish(id: string, input: CheckpointPublication, check: () => void, retentionLimits: CheckpointRetentionLimits) {
      const receipt = {
        ...input,
        summary: CheckpointArchiveSummarySchema.parse(input.summary),
        stageIdentity: { ...input.stageIdentity },
      };
      return transaction(async (tx) => {
        const row = await active(context, tx, id, check);
        if (
          row.direction !== "upload" ||
          row.state !== "streaming" ||
          !row.declaredHeader ||
          receipt.storedBytes !== row.expectedArchiveBytes ||
          !receipt.stagePath ||
          receipt.stagePath !== `${row.checkpointId}-${row.id}.tar` ||
          receipt.stageIdentity.size !== String(receipt.storedBytes) ||
          !/^sha256:[a-f0-9]{64}$/.test(receipt.archiveDigest) ||
          canonicalJson(receipt.summary.mounts) !== canonicalJson(row.declaredHeader.mounts)
        )
          throw new Error("Checkpoint publication differs from its declaration.");
        const allocatedBytes = Number(receipt.stageIdentity.allocatedBytes);
        const reservation = await checkpointUploadReservation(context, tx, row, check);
        if (!Number.isSafeInteger(allocatedBytes) || allocatedBytes < 0 || allocatedBytes > reservation.reservedBytes)
          throw new Error("Checkpoint allocated bytes exceed their reservation.");
        await assertCheckpointRetention(
          context,
          tx,
          row.declaredHeader,
          row.principalId,
          row.checkpointId,
          retentionLimits,
        );
        const at = new Date();
        await tx
          .update(reservations)
          .set({
            state: "committed",
            reservedBytes: allocatedBytes,
            materializedBytes: allocatedBytes,
            reservedFiles: 1,
            materializedFiles: 1,
            updatedAt: at,
          })
          .where(eq(reservations.id, requiredRow(row.reservationId)));
        await tx
          .update(checkpoints)
          .set({
            state: "ready",
            providerKind: "controller-archive",
            providerRef: { archivePath: receipt.stagePath, transferId: row.id },
            manifest: null,
            manifestDigest: receipt.summary.manifest_digest,
            logicalBytes: receipt.summary.mounts.reduce((n, mount) => n + mount.logical_bytes, 0),
            fileCount: receipt.summary.mounts.reduce((n, mount) => n + mount.file_count, 0),
            storedBytes: receipt.storedBytes,
            readyAt: at,
            updatedAt: at,
          })
          .where(eq(checkpoints.id, row.checkpointId));
        const [updated] = await tx
          .update(transfers)
          .set({ ...receipt, state: "complete", grantDigest: null, completedAt: at, updatedAt: at })
          .where(eq(transfers.id, id))
          .returning();
        transferDeadline(row.expiresAt, check);
        return requiredRow(updated);
      });
    },
    downloaded(id: string, check: () => void) {
      return transaction(async (tx) => {
        const row = await active(context, tx, id, check);
        if (row.direction !== "download" || row.state !== "streaming")
          throw new Error("Checkpoint download is not streaming.");
        const [updated] = await tx
          .update(transfers)
          .set({ state: "validated", updatedAt: new Date() })
          .where(eq(transfers.id, id))
          .returning();
        transferDeadline(row.expiresAt, check);
        return requiredRow(updated);
      });
    },
    installed(id: string, check: () => void) {
      return transaction(async (tx) => {
        const row = await active(context, tx, id, check);
        if (row.direction !== "download" || row.state !== "validated")
          throw new Error("Checkpoint download has not completed.");
        const at = new Date();
        await completeCheckpointStorage(context, tx, row, at);
        const [updated] = await tx
          .update(transfers)
          .set({ state: "complete", completedAt: at, updatedAt: at })
          .where(eq(transfers.id, id))
          .returning();
        transferDeadline(row.expiresAt, check);
        return requiredRow(updated);
      });
    },
    abort(id: string, checkRemoved: () => void) {
      return transaction(async (tx) => {
        const [row] = await tx.select().from(transfers).where(eq(transfers.id, id)).for("update");
        const current = requiredRow(row);
        if (current.state === "complete") throw new Error("Completed checkpoint transfer cannot abort.");
        checkRemoved();
        const at = new Date();
        if (current.reservationId)
          await tx
            .update(reservations)
            .set({
              state: "released",
              reservedBytes: 0,
              materializedBytes: 0,
              reservedFiles: 0,
              materializedFiles: 0,
              releasedAt: at,
              updatedAt: at,
            })
            .where(eq(reservations.id, current.reservationId));
        const [updated] = await tx
          .update(transfers)
          .set({
            state: "aborted",
            grantDigest: null,
            stagePath: null,
            stageIdentity: null,
            updatedAt: at,
            completedAt: at,
          })
          .where(eq(transfers.id, id))
          .returning();
        checkRemoved();
        return requiredRow(updated);
      });
    },
    removePublication(id: string, checkRemoved: () => void) {
      return transaction(async (tx) => {
        const [row] = await tx.select().from(transfers).where(eq(transfers.id, id)).for("update");
        const current = requiredRow(row);
        const [checkpoint] = await tx
          .select()
          .from(checkpoints)
          .where(eq(checkpoints.id, current.checkpointId))
          .for("update");
        if (
          current.direction !== "upload" ||
          current.state !== "complete" ||
          checkpoint?.state !== "deleting" ||
          checkpoint.principalId !== current.principalId
        )
          throw new Error("Checkpoint archive is not admitted for deletion.");
        checkRemoved();
        const at = new Date();
        if (current.reservationId)
          await tx
            .update(reservations)
            .set({
              state: "released",
              reservedBytes: 0,
              materializedBytes: 0,
              reservedFiles: 0,
              materializedFiles: 0,
              releasedAt: at,
              updatedAt: at,
            })
            .where(eq(reservations.id, current.reservationId));
        const [updated] = await tx
          .update(transfers)
          .set({ state: "aborted", stagePath: null, stageIdentity: null, updatedAt: at })
          .where(eq(transfers.id, id))
          .returning();
        checkRemoved();
        return requiredRow(updated);
      });
    },
    async publication(checkpointId: string): Promise<CheckpointTransferRow | null> {
      const rows = await db.select().from(transfers).where(eq(transfers.checkpointId, checkpointId));
      return rows.find((row) => row.direction === "upload" && row.state === "complete") ?? null;
    },
  };
}
