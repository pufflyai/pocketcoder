import { ApiError, canonicalJson, InputObjectReferenceSchema } from "@pstdio/pocketcoder-contracts";
import type { InputClaim, InputLimits, ReadStorageCapacity } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq } from "drizzle-orm";
import type { DatabaseContext, QueryContext, Transaction } from "../../../database/context";
import { requiredRow } from "../../../database/required-row";
import { admitStorageOwner, lockStorageCapacity, reserveStorage } from "../reservation-capacity";

import { inputIsPinned } from "./pins";

export function inputKey(context: DatabaseContext, workspaceId: string, fileId: string) {
  const table = context.tables.inputObjects;
  return and(eq(table.workspaceId, workspaceId), eq(table.fileId, fileId));
}
export async function readInput(context: DatabaseContext, tx: QueryContext, workspaceId: string, fileId: string) {
  const [row] = await tx
    .select()
    .from(context.tables.inputObjects)
    .where(inputKey(context, workspaceId, fileId));
  return row ?? null;
}
export function createInputObjects(context: DatabaseContext) {
  const {
    db,
    tables: { inputObjects: objects, storageReservations: reservations },
  } = context;
  return {
    get: (workspaceId: string, fileId: string) => readInput(context, db, workspaceId, fileId),
    list: () => db.select().from(objects),
    begin(input: InputClaim, limits: InputLimits, capacity: ReadStorageCapacity) {
      return db.transaction(async (tx) => {
        await lockStorageCapacity(context, tx);
        const reference = InputObjectReferenceSchema.parse(input.reference);
        let existing = await readInput(context, tx, reference.workspaceId, reference.fileId);
        if (existing?.state === "expired" && !existing.publishedAt) {
          await tx.delete(objects).where(inputKey(context, reference.workspaceId, reference.fileId));
          existing = null;
        }
        if (existing) return existingInput(context, tx, existing, reference);

        if (reference.sizeBytes > limits.fileBytes)
          throw new ApiError("attachment.too_large", "Input exceeds the per-file limit.");
        await checkInputCapacity(context, tx, reference, limits);
        await reserveStorage(
          context,
          tx,
          {
            id: input.reservationId,
            purpose: "attachment",
            workspaceId: reference.workspaceId,
            principalId: input.principalId,
            operationId: null,
            reservedBytes: reference.sizeBytes,
            reservedFiles: 1,
            expiresAt: input.transferExpiresAt,
          },
          capacity,
          () => {},
        );
        const [row] = await tx
          .insert(objects)
          .values({
            ...input,
            reference,
            workspaceId: reference.workspaceId,
            fileId: reference.fileId,
            state: "uploading",
          })
          .returning();
        return { row: requiredRow(row), created: true };
      });
    },
    publish(workspaceId: string, fileId: string, reservationId: string) {
      return db.transaction(async (tx) => {
        await lockStorageCapacity(context, tx);
        const row = requiredRow(await readInput(context, tx, workspaceId, fileId));
        if (row.reservationId !== reservationId || row.state !== "uploading" || row.transferExpiresAt <= new Date())
          throw new Error("Input transfer ownership expired.");
        await admitStorageOwner(
          context,
          tx,
          {
            id: reservationId,
            purpose: "attachment",
            workspaceId,
            principalId: row.principalId,
            operationId: null,
            reservedBytes: row.reference.sizeBytes,
            reservedFiles: 1,
            expiresAt: row.transferExpiresAt,
          },
          () => {},
        );
        await tx
          .update(reservations)
          .set({
            state: "committed",
            materializedBytes: row.reference.sizeBytes,
            materializedFiles: 1,
            updatedAt: new Date(),
          })
          .where(eq(reservations.id, reservationId));
        const [published] = await tx
          .update(objects)
          .set({ state: "ready", publishedAt: new Date(), retainedUntil: new Date(Date.now() + row.retentionMs) })
          .where(inputKey(context, workspaceId, fileId))
          .returning();
        return requiredRow(published);
      });
    },
    async unavailable(workspaceId: string, fileId: string) {
      await db.transaction(async (tx) => {
        await lockStorageCapacity(context, tx);
        const row = requiredRow(await readInput(context, tx, workspaceId, fileId));
        if (row.state !== "ready") return;
        await tx
          .update(objects)
          .set({ state: "unavailable", reference: { ...row.reference, visibility: "unavailable" } })
          .where(inputKey(context, workspaceId, fileId));
      });
    },
  };
}

async function checkInputCapacity(
  context: DatabaseContext,
  tx: Transaction,
  reference: InputClaim["reference"],
  limits: InputLimits,
) {
  const objects = context.tables.inputObjects;
  const scoped = await tx.select().from(objects).where(eq(objects.workspaceId, reference.workspaceId));
  const charged = scoped.filter((row) => row.state !== "expired");
  if (
    charged.length >= limits.files ||
    charged.reduce((n, row) => n + row.reference.sizeBytes, 0) + reference.sizeBytes > limits.stagedBytes ||
    scoped.filter((row) => row.state === "uploading").length >= limits.transfers
  )
    throw new ApiError("storage.capacity_exhausted", "Input staging capacity is exhausted.");
}

async function existingInput(
  context: DatabaseContext,
  tx: Transaction,
  existing: NonNullable<Awaited<ReturnType<typeof readInput>>>,
  reference: InputClaim["reference"],
) {
  if (canonicalJson({ ...existing.reference, visibility: "ready" }) !== canonicalJson(reference))
    throw new ApiError("attachment.conflict", "This input ID has a different descriptor.");
  if (existing.state === "uploading") throw new ApiError("operation.conflict", "This input has an active transfer.");
  if (
    existing.state !== "ready" ||
    (existing.retainedUntil <= new Date() &&
      !(await inputIsPinned(context, tx, reference.workspaceId, reference.fileId)))
  )
    throw new ApiError("attachment.not_found", "This input is unavailable; stage a new ID.");
  return { row: existing, created: false };
}
