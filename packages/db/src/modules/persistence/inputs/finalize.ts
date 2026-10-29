import { eq } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../../database/context";
import { requiredRow } from "../../../database/required-row";
import { inputKey, readInput } from "./objects";

// The caller holds the storage-capacity lock in the same transaction.
export async function finalizeInputManifest(context: DatabaseContext, tx: Transaction, id: string, at: Date) {
  const { inputObjects, inputManifests } = context.tables;
  const [row] = await tx.select().from(inputManifests).where(eq(inputManifests.id, id));
  if (!row || row.finalizedAt) return;
  for (const object of row.manifest.objects) {
    const stored = requiredRow(await readInput(context, tx, object.workspaceId, object.fileId));
    await tx
      .update(inputObjects)
      .set({ retainedUntil: new Date(at.getTime() + stored.retentionMs) })
      .where(inputKey(context, object.workspaceId, object.fileId));
  }
  await tx.update(inputManifests).set({ finalizedAt: at }).where(eq(inputManifests.id, id));
}
