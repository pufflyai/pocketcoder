import { randomUUID } from "node:crypto";
import { ApiError, digestOf } from "@pstdio/pocketcoder-contracts";
import type {
  InvocationRecord,
  ManagedInvocationIdentity,
  ManagedUsageEvidence,
} from "@pstdio/pocketcoder-runtime-contracts";
import { eq, inArray } from "drizzle-orm";
import { type DatabaseContext, lock, type Transaction } from "../../database/context";
import { authorityContext } from "../managed/authority-context";
import { budgetLedger } from "./ledger";

function evidenceFingerprint(input: ManagedUsageEvidence) {
  const { observedAt, ...facts } = input;
  return digestOf(facts);
}
function validate(input: ManagedUsageEvidence) {
  if (
    !Number.isSafeInteger(input.inputTokens) ||
    input.inputTokens < 0 ||
    !Number.isSafeInteger(input.outputTokens) ||
    input.outputTokens < 0 ||
    !input.provider ||
    !input.providerAccountId ||
    !input.responseId ||
    !input.providerEvidenceRef ||
    input.providerEvidenceRef.length > 1024 ||
    !Number.isFinite(input.observedAt.getTime())
  )
    throw new ApiError("validation.invalid", "Trusted usage evidence is required.");
}
function conflictingUsage(record: InvocationRecord, input: ManagedUsageEvidence) {
  return (
    record.state === "conflict" ||
    record.evidence !== null ||
    input.inputTokens > record.reservation.inputTokens ||
    input.outputTokens > record.reservation.outputTokenCap
  );
}

export function settlementOwner(context: DatabaseContext, now: () => Date) {
  const { db, tables } = context;
  const ledger = budgetLedger(context, now);
  const auth = authorityContext(context);
  async function locked(tx: Transaction, identity: ManagedInvocationIdentity) {
    const known = await ledger.known(tx, identity);
    if (!known) throw new ApiError("budget.not_found", "Unknown invocation.");
    const { at } = await ledger.lockScopes(tx, known.reservation.scopeIds);
    await lock(tx, identity.invocationId, 35);
    const record = await ledger.known(tx, identity);
    if (!record) throw new ApiError("budget.not_found", "Unknown invocation.");
    return { record, at };
  }
  async function block(tx: Transaction, record: InvocationRecord, reason: string) {
    await tx
      .update(tables.managedScopes)
      .set({ blockedReason: reason })
      .where(inArray(tables.managedScopes.scopeId, record.reservation.scopeIds));
  }
  return {
    async settle(input: ManagedUsageEvidence) {
      validate(input);
      await db.transaction(async (tx) => {
        const { record, at } = await locked(tx, input.identity);
        if (record.state === "reserved" || record.state === "abandoned")
          throw new ApiError("budget.conflict", "Usage requires a claimed invocation.");
        if (record.evidence && evidenceFingerprint(record.evidence) === evidenceFingerprint(input)) return;
        const inserted = await tx
          .insert(tables.budgetReports)
          .values({
            invocationId: input.identity.invocationId,
            digest: evidenceFingerprint(input),
            evidence: input,
            recordedAt: at,
          })
          .onConflictDoNothing()
          .returning({ digest: tables.budgetReports.digest });
        if (!inserted.length) return;
        const conflict = conflictingUsage(record, input);
        record.settledInput = Math.max(record.settledInput, input.inputTokens);
        record.settledOutput = Math.max(record.settledOutput, input.outputTokens);
        record.state = conflict ? "conflict" : "settled";
        // The server records the time span; a late or backdated callback cannot erase touched periods.
        record.touchedUntil = new Date(
          Math.max(record.touchedUntil.getTime(), at.getTime(), input.observedAt.getTime()),
        );
        if (record.evidence === null) {
          record.evidence = input;
          record.evidenceDigest = evidenceFingerprint(input);
        }
        await ledger.write(tx, record);
        if (conflict) await block(tx, record, "conflicting_usage");
      });
    },
    async retainUncertain(identity: ManagedInvocationIdentity) {
      await db.transaction(async (tx) => {
        const { record, at } = await locked(tx, identity);
        if (record.state === "reserved")
          throw new ApiError("budget.conflict", "Uncertainty requires a claimed invocation.");
        if (record.state === "settled" || record.state === "conflict" || record.state === "abandoned") return;
        record.state = "uncertain";
        record.touchedUntil = at;
        await ledger.write(tx, record);
      });
    },
    async reconcile(keyId: string, input: ManagedUsageEvidence, reason: string) {
      validate(input);
      if (!reason.trim() || reason.length > 2048)
        throw new ApiError("validation.invalid", "An audit reason is required.");
      await db.transaction(async (tx) => {
        await auth.caller(tx, keyId, "admin");
        const { record, at } = await locked(tx, input.identity);
        const previous = structuredClone(record);
        await tx
          .insert(tables.budgetReports)
          .values({
            invocationId: input.identity.invocationId,
            digest: evidenceFingerprint(input),
            evidence: input,
            recordedAt: at,
          })
          .onConflictDoNothing();
        if (
          record.state === "settled" &&
          record.evidence &&
          evidenceFingerprint(record.evidence) === evidenceFingerprint(input)
        )
          return;
        record.state = "settled";
        record.settledInput = input.inputTokens;
        record.settledOutput = input.outputTokens;
        record.evidence = input;
        record.evidenceDigest = evidenceFingerprint(input);
        record.touchedUntil = new Date(
          Math.max(record.touchedUntil.getTime(), at.getTime(), input.observedAt.getTime()),
        );
        await ledger.write(tx, record);
        await tx.insert(tables.budgetAudits).values({
          id: randomUUID(),
          invocationId: input.identity.invocationId,
          actorKeyId: keyId,
          reason,
          previous,
          next: record,
          createdAt: at,
        });
        const all = await ledger.records(tx);
        for (const scopeId of record.reservation.scopeIds) {
          if (!all.some((r) => r.state === "conflict" && r.reservation.scopeIds.includes(scopeId)))
            await tx
              .update(tables.managedScopes)
              .set({ blockedReason: null })
              .where(eq(tables.managedScopes.scopeId, scopeId));
        }
      });
    },
  };
}
