import { SourceWriterSchema } from "@pstdio/pocketcoder-contracts";
import type { CheckpointTransferRow } from "@pstdio/pocketcoder-runtime-contracts";
import { eq, sql } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { sourceWriterIdentity } from "../../recovery/source-writer";
import { assertUploadPreservationDeadline } from "./upload-preservation-deadline";

export function transferDeadline(expiresAt: Date, check: () => void) {
  check();
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date())
    throw new Error("Checkpoint transfer authority expired.");
}

export async function checkpointUploadAuthority(
  context: DatabaseContext,
  tx: Transaction,
  transfer: Pick<
    CheckpointTransferRow,
    "id" | "operationId" | "checkpointId" | "workspaceId" | "connectionEpoch" | "expiresAt"
  >,
  check: () => void,
) {
  await checkpointControllerAuthority(context, tx, transfer.expiresAt, check);
  const { workspaceOperations: operations, workspaces, workspaceCheckpoints: checkpoints, principals } = context.tables;
  transferDeadline(transfer.expiresAt, check);
  const [operation] = await tx.select().from(operations).where(eq(operations.id, transfer.operationId)).for("update");
  const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, transfer.workspaceId)).for("update");
  const [checkpoint] = await tx
    .select()
    .from(checkpoints)
    .where(eq(checkpoints.id, transfer.checkpointId))
    .for("update");
  transferDeadline(transfer.expiresAt, check);
  if (workspace && !Number.isFinite(workspace.deadlineAt.getTime()))
    throw new Error("Checkpoint workspace deadline authority is invalid.");
  if (
    !operation ||
    !workspace ||
    !checkpoint ||
    operation.kind !== "preserve" ||
    !["pending", "running"].includes(operation.state) ||
    operation.workspaceId !== workspace.id ||
    operation.checkpointId !== checkpoint.id ||
    operation.principalId !== workspace.principalId ||
    checkpoint.principalId !== workspace.principalId ||
    checkpoint.workspaceId !== workspace.id ||
    checkpoint.state !== "creating" ||
    checkpoint.templateDigest !== workspace.templateDigest ||
    workspace.state !== "preserving" ||
    workspace.terminalAt ||
    workspace.purgeRequestedAt ||
    workspace.connectionEpoch !== transfer.connectionEpoch
  )
    throw new Error("Checkpoint upload authority is invalid.");
  await assertUploadPreservationDeadline(context, tx, workspace, operation, transfer.expiresAt, transfer.id);
  const [principal] = await tx.select().from(principals).where(eq(principals.id, workspace.principalId)).for("update");
  transferDeadline(transfer.expiresAt, check);
  if (!principal || principal.disabledAt) throw new Error("Checkpoint upload principal authority is invalid.");
  return { operation, workspace, checkpoint };
}

export async function checkpointUploadReservation(
  context: DatabaseContext,
  tx: Transaction,
  transfer: CheckpointTransferRow,
  check: () => void,
) {
  if (!transfer.reservationId) throw new Error("Checkpoint transfer reservation is missing.");
  const reservations = context.tables.storageReservations;
  const transfers = context.tables.checkpointTransfers;
  const [bound] = await tx
    .select({
      reservation: reservations,
      exactExpiry: sql<boolean>`${reservations.expiresAt} = ${transfers.expiresAt}`,
    })
    .from(reservations)
    .innerJoin(transfers, eq(transfers.reservationId, reservations.id))
    .where(eq(transfers.id, transfer.id))
    .for("update");
  const reservation = bound?.reservation;
  transferDeadline(transfer.expiresAt, check);
  if (
    reservation?.state !== "reserved" ||
    reservation.purpose !== "checkpoint-upload" ||
    reservation.operationId !== transfer.operationId ||
    reservation.workspaceId !== transfer.workspaceId ||
    reservation.principalId !== transfer.principalId ||
    bound?.exactExpiry !== true ||
    transfer.expectedArchiveBytes === null ||
    transfer.expectedArchiveBytes <= 0 ||
    reservation.reservedBytes < transfer.expectedArchiveBytes ||
    reservation.reservedFiles < 1
  )
    throw new Error("Checkpoint transfer reservation authority is invalid.");
  return reservation;
}

export async function checkpointControllerAuthority(
  context: DatabaseContext,
  tx: Transaction,
  expiresAt: Date,
  check: () => void,
) {
  context.validateStorage?.();
  const states = await tx.select().from(context.tables.controllerState).for("update");
  transferDeadline(expiresAt, check);
  const state = states[0];
  if (states.length !== 1 || state?.id !== "controller" || state.recovery !== null)
    throw new Error("Checkpoint transfers are closed during controller recovery.");
  if (
    !state.sourceWriter ||
    !context.dataWriter ||
    sourceWriterIdentity(SourceWriterSchema.parse(state.sourceWriter)) !== sourceWriterIdentity(context.dataWriter)
  )
    throw new Error("Checkpoint transfer requires the current controller data writer.");
}
