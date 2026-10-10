import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";

// Journal records list the exact keys a revocation covers, read under the principal's lock.
export async function unrevokedKeyIds(
  tx: Transaction,
  { machineKeys }: DatabaseContext["tables"],
  principalId: string,
  needed = true,
) {
  if (!needed) return [];
  const rows = await tx
    .select({ id: machineKeys.id })
    .from(machineKeys)
    .where(and(eq(machineKeys.principalId, principalId), isNull(machineKeys.revokedAt)));
  return rows.map((row) => row.id);
}

export async function revokeKeyIds(
  tx: Transaction,
  { machineKeys }: DatabaseContext["tables"],
  ids: string[],
  at: Date,
) {
  if (ids.length)
    await tx
      .update(machineKeys)
      .set({ revokedAt: at })
      .where(and(inArray(machineKeys.id, ids), isNull(machineKeys.revokedAt)));
}
