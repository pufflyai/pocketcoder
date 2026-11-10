import { ApiError } from "@pstdio/pocketcoder-contracts";
import { inArray } from "drizzle-orm";
import { type DatabaseContext, lock, type Transaction } from "../../database/context";

// Capacity checks lock every scope of a profile in sorted order. The durable clock floor stops a
// backward wall-clock move from reopening a past period.
export async function lockScopes({ tables }: DatabaseContext, tx: Transaction, ids: string[], now: Date) {
  const scopes = tables.managedScopes;
  for (const id of [...ids].sort()) await lock(tx, id, 34);
  const rows = await tx.select().from(scopes).where(inArray(scopes.scopeId, ids)).orderBy(scopes.scopeId).for("update");
  if (rows.length !== ids.length) throw new ApiError("budget.not_found", "A required budget scope is missing.");
  const at = new Date(Math.max(now.getTime(), ...rows.map((r) => r.lastClockAt.getTime())));
  await tx.update(scopes).set({ lastClockAt: at }).where(inArray(scopes.scopeId, ids));
  return at;
}
