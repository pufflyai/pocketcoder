import { ApiError, digestOf } from "@pstdio/pocketcoder-contracts";
import type { InvocationRecord, ManagedInvocationIdentity } from "@pstdio/pocketcoder-runtime-contracts";
import { eq, inArray } from "drizzle-orm";
import { type DatabaseContext, lock, type Transaction } from "../../database/context";

export function invocationKey(identity: ManagedInvocationIdentity) {
  return digestOf(identity);
}
export function hydrate(record: InvocationRecord): InvocationRecord {
  return {
    ...record,
    reservation: { ...record.reservation, reservedAt: new Date(record.reservation.reservedAt) },
    touchedUntil: new Date(record.touchedUntil),
    evidence: record.evidence ? { ...record.evidence, observedAt: new Date(record.evidence.observedAt) } : null,
  };
}
export function budgetLedger({ tables }: DatabaseContext, now: () => Date) {
  const { managedScopes: scopes, budgetInvocations: invocations } = tables;
  async function lockScopes(tx: Transaction, ids: string[]) {
    for (const id of [...ids].sort()) await lock(tx, id, 34);
    const rows = await tx
      .select()
      .from(scopes)
      .where(inArray(scopes.scopeId, ids))
      .orderBy(scopes.scopeId)
      .for("update");
    if (rows.length !== ids.length) throw new ApiError("budget.not_found", "A required budget scope is missing.");
    const at = new Date(Math.max(now().getTime(), ...rows.map((r) => r.lastClockAt.getTime())));
    await tx.update(scopes).set({ lastClockAt: at }).where(inArray(scopes.scopeId, ids));
    return { rows, at };
  }
  async function known(tx: Transaction, identity: ManagedInvocationIdentity) {
    const [row] = await tx.select().from(invocations).where(eq(invocations.invocationId, identity.invocationId));
    if (!row) return null;
    if (invocationKey(row.record.reservation.identity) !== invocationKey(identity))
      throw new ApiError("idempotency.conflict", "Invocation identity changed.");
    return hydrate(row.record);
  }
  async function records(tx: Transaction) {
    return (await tx.select().from(invocations)).map((row) => hydrate(row.record));
  }
  async function write(tx: Transaction, record: InvocationRecord) {
    await tx
      .update(invocations)
      .set({ record })
      .where(eq(invocations.invocationId, record.reservation.identity.invocationId));
  }
  async function required(tx: Transaction, identity: ManagedInvocationIdentity) {
    const record = await known(tx, identity);
    if (!record) throw new ApiError("budget.not_found", "Unknown invocation.");
    return record;
  }
  return { lockScopes, known, required, records, write };
}
