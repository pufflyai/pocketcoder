import { ApiError, digestOf, type managed } from "@pstdio/pocketcoder-contracts";
import type { InvocationInput, InvocationRecord } from "@pstdio/pocketcoder-runtime-contracts";
import { type DatabaseContext, lock } from "../../database/context";
import { unavailable } from "../managed/authority-context";
import { assertRoom, exposure } from "./accounting";
import { invocationAuthority } from "./invocation-authority";
import { budgetLedger } from "./ledger";
import { policyOwner } from "./policy-owner";

function validTokens(value: number) {
  return Number.isSafeInteger(value) && value >= 0;
}
function fingerprint(input: InvocationInput) {
  return digestOf(input);
}
function enforce(
  policy: managed.BudgetPolicy,
  records: InvocationRecord[],
  input: InvocationInput,
  output: number,
  at: Date,
) {
  const { scopeId, limits } = policy;
  const e = exposure(records, scopeId, policy, at);
  assertRoom(limits.inputTokens, e.effectiveInput, input.inputTokens);
  assertRoom(limits.outputTokens, e.effectiveOutput, output);
  assertRoom(limits.maxInFlightModelRequests, e.active.length, 1);
  const recent = records.filter(
    (r) =>
      r.reservation.scopeIds.includes(scopeId) && new Date(r.reservation.reservedAt).getTime() > at.getTime() - 60_000,
  );
  assertRoom(limits.modelRequestsPerMinute, recent.length, 1);
  assertRoom(
    limits.modelRequestsPerMinutePerWorkspace,
    recent.filter((r) => r.workspaceId === input.workspaceId).length,
    1,
  );
  const model = policy.modelLimits.find((m) => m.model === input.model);
  if (model) {
    const m = exposure(records, scopeId, policy, at, input.model);
    assertRoom(model.inputTokens, m.effectiveInput, input.inputTokens);
    assertRoom(model.outputTokens, m.effectiveOutput, output);
  }
}

export function reservationOwner(context: DatabaseContext, now: () => Date) {
  const { db, tables } = context;
  const authority = invocationAuthority(context);
  const ledger = budgetLedger(context, now);
  const policies = policyOwner(context);
  return {
    async reserve(input: InvocationInput) {
      if (
        !/^sha256:[a-f0-9]{64}$/.test(input.requestDigest) ||
        !input.countEvidenceRef ||
        input.countEvidenceRef.length > 1024
      )
        throw new ApiError("validation.invalid", "A frozen request digest and trusted count evidence are required.");
      if (
        !validTokens(input.inputTokens) ||
        (input.requestedOutputTokens !== null &&
          (!validTokens(input.requestedOutputTokens) || input.requestedOutputTokens === 0))
      )
        throw new ApiError("validation.invalid", "Trustworthy input bounds and a positive output cap are required.");
      return db.transaction(async (tx) => {
        const { session, profile } = await authority.reserve(tx, input);
        const { rows, at } = await ledger.lockScopes(tx, profile.budgetScopeIds);
        await lock(tx, input.identity.invocationId, 35);
        const existing = await ledger.known(tx, input.identity);
        if (existing) {
          if (existing.fingerprint !== fingerprint(input))
            throw new ApiError("idempotency.conflict", "Invocation input changed.");
          return { replayed: true, reservation: existing.reservation };
        }
        if (rows.some((row) => row.blockedReason))
          throw new ApiError("budget.exhausted", "Budget scope requires reconciliation.");
        if (session.binding?.workspaceId !== input.workspaceId) throw unavailable();
        if (!session.binding) throw unavailable();
        await authority.workspace(tx, input.workspaceId, session.binding.incarnationId, at);
        const selected = await Promise.all(profile.budgetScopeIds.map((id) => policies.latest(tx, id)));
        const maximum = Math.min(...selected.map((p) => p.limits.maxOutputTokensPerInvocation));
        const output = Math.min(
          input.requestedOutputTokens ?? Math.min(...selected.map((p) => p.limits.defaultOutputTokens)),
          maximum,
        );
        const records = await ledger.records(tx);
        for (const policy of selected) enforce(policy, records, input, output, at);
        const reservation = {
          identity: input.identity,
          profileId: profile.profileId,
          profileRevision: profile.revision,
          scopeIds: [...profile.budgetScopeIds].sort(),
          model: input.model,
          inputTokens: input.inputTokens,
          outputTokenCap: output,
          reservedAt: at,
        };
        const record: InvocationRecord = {
          bindingRevision: session.bindingRevision,
          generation: session.binding.generation,
          incarnationId: session.binding.incarnationId,
          reservation,
          workspaceId: input.workspaceId,
          fingerprint: fingerprint(input),
          policyRevisions: Object.fromEntries(selected.map((p) => [p.scopeId, p.revision])),
          state: "reserved",
          settledInput: 0,
          settledOutput: 0,
          evidence: null,
          evidenceDigest: null,
          touchedUntil: at,
        };
        await tx
          .insert(tables.budgetInvocations)
          .values({ invocationId: input.identity.invocationId, record, reservedAt: at });
        return { replayed: false, reservation };
      });
    },
  };
}
