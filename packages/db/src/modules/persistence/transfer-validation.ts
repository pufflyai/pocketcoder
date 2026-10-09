import { canonicalJson } from "@pstdio/pocketcoder-contracts";
import { eq } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { requiredRow } from "../../database/required-row";
import { checkpointDownloadAuthority } from "./download-authority";
import { checkpointUploadAuthority, checkpointUploadReservation, transferDeadline } from "./transfer-authority";

export async function validateCheckpointTransfer(
  context: DatabaseContext,
  tx: Transaction,
  id: string,
  check: () => void,
) {
  check();
  context.validateStorage?.();
  const [found] = await tx
    .select()
    .from(context.tables.checkpointTransfers)
    .where(eq(context.tables.checkpointTransfers.id, id))
    .for("update");
  const row = requiredRow(found);
  if (!["granted", "streaming", "validated", "publishing"].includes(row.state))
    throw new Error("Checkpoint transfer is not active.");
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
