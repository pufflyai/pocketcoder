import { ApiError, type managed } from "@pstdio/pocketcoder-contracts";
import type { InvocationRecord } from "@pstdio/pocketcoder-runtime-contracts";

export function periodAt(at: Date, period: managed.BudgetPolicy["period"]) {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), period === "utc_day" ? at.getUTCDate() : 1));
  const end = new Date(start);
  if (period === "utc_day") end.setUTCDate(end.getUTCDate() + 1);
  else end.setUTCMonth(end.getUTCMonth() + 1);
  return { start, end };
}
export function exposure(
  records: InvocationRecord[],
  scopeId: string,
  policy: managed.BudgetPolicy,
  at: Date,
  model?: string,
) {
  const { start, end } = periodAt(at, policy.period);
  const matching = records.filter(
    (r) =>
      r.state !== "abandoned" && r.reservation.scopeIds.includes(scopeId) && (!model || r.reservation.model === model),
  );
  const active = matching.filter((r) => r.state !== "settled");
  const touched = matching.filter(
    (r) => new Date(r.reservation.reservedAt) < end && (r.state === "settled" ? new Date(r.touchedUntil) : at) >= start,
  );
  const sum = (fn: (r: InvocationRecord) => number) => touched.reduce((a, r) => a + fn(r), 0);
  const settledInput = sum((r) => r.settledInput);
  const settledOutput = sum((r) => r.settledOutput);
  const heldInput = sum((r) => (r.state === "settled" ? 0 : Math.max(0, r.reservation.inputTokens - r.settledInput)));
  const heldOutput = sum((r) =>
    r.state === "settled" ? 0 : Math.max(0, r.reservation.outputTokenCap - r.settledOutput),
  );
  return {
    start,
    end,
    active,
    settledInput,
    settledOutput,
    heldInput,
    heldOutput,
    effectiveInput: settledInput + heldInput,
    effectiveOutput: settledOutput + heldOutput,
  };
}
export function assertRoom(limit: number | null, used: number, requested: number) {
  if (!Number.isSafeInteger(used + requested) || (limit !== null && used + requested > limit))
    throw new ApiError("budget.exhausted", "A runtime budget limit was reached.");
}
export function usageSnapshot(
  records: InvocationRecord[],
  policy: managed.BudgetPolicy,
  at: Date,
  blockedReason: string | null,
): managed.BudgetUsage {
  const e = exposure(records, policy.scopeId, policy, at);
  const oldest = e.active.map((r) => new Date(r.reservation.reservedAt).getTime()).sort((a, b) => a - b)[0];
  return {
    scopeId: policy.scopeId,
    policyRevision: policy.revision,
    periodStart: e.start.toISOString(),
    periodEnd: e.end.toISOString(),
    settledInputTokens: e.settledInput,
    settledOutputTokens: e.settledOutput,
    heldInputTokens: e.heldInput,
    heldOutputTokens: e.heldOutput,
    effectiveInputTokens: e.effectiveInput,
    effectiveOutputTokens: e.effectiveOutput,
    remainingInputTokens:
      policy.limits.inputTokens === null ? null : Math.max(0, policy.limits.inputTokens - e.effectiveInput),
    remainingOutputTokens:
      policy.limits.outputTokens === null ? null : Math.max(0, policy.limits.outputTokens - e.effectiveOutput),
    workspaceStarts: 0,
    activeWorkspaces: 0,
    inFlightModelRequests: e.active.length,
    unresolvedInvocations: e.active.filter((r) => r.state === "uncertain" || r.state === "conflict").length,
    oldestUnresolvedAt: oldest === undefined ? null : new Date(oldest).toISOString(),
    blockedReason,
    asOf: at.toISOString(),
  };
}
