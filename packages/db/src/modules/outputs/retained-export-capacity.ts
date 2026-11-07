import { ApiError, type WorkloadExportReference } from "@pstdio/pocketcoder-contracts";
import type { StorageCapacity } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { checkStorageCapacity, lockStorageCapacity, storageUsage } from "../persistence/reservation-capacity";

export async function reserveExport(
  context: DatabaseContext,
  tx: Transaction,
  manifest: WorkloadExportReference,
  principalId: string,
  at: Date,
  capacity?: StorageCapacity,
) {
  if (!manifest.objects.length) return;
  if (!capacity) throw new ApiError("storage.capacity_exhausted", "Explicit retained export capacity is required.");
  const input = {
    id: manifest.exportId,
    purpose: "export" as const,
    operationId: null,
    workspaceId: manifest.execution.workspaceId,
    principalId,
    reservedBytes: manifest.objects.reduce((sum, object) => sum + object.sizeBytes, 0),
    reservedFiles: manifest.objects.length,
    expiresAt: new Date(manifest.expiresAt),
  };
  const usage = await storageUsage(context, tx, input.workspaceId, principalId);
  checkStorageCapacity(usage, input, capacity);
  await tx.insert(context.tables.storageReservations).values({
    ...input,
    state: "committed",
    materializedBytes: input.reservedBytes,
    materializedFiles: input.reservedFiles,
    createdAt: at,
    updatedAt: at,
  });
}

export async function deleteExportBytes(
  context: DatabaseContext,
  tx: Transaction,
  predicate: import("drizzle-orm").SQL,
  at: Date,
) {
  await lockStorageCapacity(context, tx);
  const objects = context.tables.exportObjects;
  const removed = await tx
    .update(objects)
    .set({ data: null, deletedAt: at })
    .where(and(predicate, isNull(objects.deletedAt)))
    .returning({ exportId: objects.exportId });
  if (!removed.length) return;
  await tx
    .update(context.tables.storageReservations)
    .set({
      state: "released",
      reservedBytes: 0,
      reservedFiles: 0,
      materializedBytes: 0,
      materializedFiles: 0,
      releasedAt: at,
      updatedAt: at,
    })
    .where(
      and(
        eq(context.tables.storageReservations.purpose, "export"),
        inArray(
          context.tables.storageReservations.id,
          removed.map((row) => row.exportId),
        ),
      ),
    );
}
