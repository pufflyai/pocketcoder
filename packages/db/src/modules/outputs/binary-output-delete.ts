import { and, eq, inArray, ne } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";

export async function deleteBinaryOutputs(context: DatabaseContext, tx: Transaction, ids: string[], at: Date) {
  if (!ids.length) return;
  const { binaryOutputs, storageReservations } = context.tables;
  const rows = await tx
    .update(binaryOutputs)
    .set({
      state: "deleted",
      data: null,
      bytes: null,
      digest: null,
      grantDigest: null,
    })
    .where(and(inArray(binaryOutputs.id, ids), ne(binaryOutputs.state, "deleted")))
    .returning({ reservationId: binaryOutputs.reservationId });
  if (!rows.length) return;
  await tx
    .update(storageReservations)
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
      inArray(
        storageReservations.id,
        rows.map((row) => row.reservationId),
      ),
    );
}

export async function purgeBinaryOutputs(context: DatabaseContext, tx: Transaction, workspaceId: string, at: Date) {
  const rows = await tx
    .select({ id: context.tables.binaryOutputs.id })
    .from(context.tables.binaryOutputs)
    .where(eq(context.tables.binaryOutputs.workspaceId, workspaceId));
  await deleteBinaryOutputs(
    context,
    tx,
    rows.map((row) => row.id),
    at,
  );
}
