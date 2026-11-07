import { ApiError, digestOf, type managed } from "@pstdio/pocketcoder-contracts";

export function replayPolicy(prior: managed.BudgetPolicy, input: managed.BudgetPolicyWrite, expected: number | null) {
  const { effectiveAt, ...body } = prior;
  if (digestOf(body) !== digestOf(input)) throw new ApiError("budget.conflict", "Policy revision is immutable.");
  const previous = input.revision === 1 ? null : input.revision - 1;
  if (expected !== previous) throw new ApiError("revision.stale", "Invalid write precondition.");
  return prior;
}
export function nextPolicy(
  previous: managed.BudgetPolicy | undefined,
  input: managed.BudgetPolicyWrite,
  expected: number | null,
) {
  const revision = previous?.revision ?? 0;
  if ((previous?.revision ?? null) !== expected || input.revision !== revision + 1)
    throw new ApiError("revision.stale", "Budget policy revision changed.");
}
