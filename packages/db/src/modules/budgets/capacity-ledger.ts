import { ApiError, type managed } from "@pstdio/pocketcoder-contracts";
import type { DatabaseContext, Transaction } from "../../database/context";

export function periodAt(at: Date, period: managed.BudgetPolicy["period"]) {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), period === "utc_day" ? at.getUTCDate() : 1));
  const end = new Date(start);
  if (period === "utc_day") end.setUTCDate(end.getUTCDate() + 1);
  else end.setUTCMonth(end.getUTCMonth() + 1);
  return { start, end };
}
export function assertRoom(limit: number | null, used: number, requested: number) {
  if (!Number.isSafeInteger(used + requested) || (limit !== null && used + requested > limit))
    throw new ApiError("budget.exhausted", "A runtime budget limit was reached.");
}

export async function capacityUsage(context: DatabaseContext, tx: Transaction, policy: managed.BudgetPolicy, at: Date) {
  const { start, end } = periodAt(at, policy.period);
  const rows = (await tx.select().from(context.tables.managedCapacity)).filter((row) =>
    row.record.scopeIds.includes(policy.scopeId),
  );
  return {
    pendingStarts: rows.filter(
      (row) =>
        row.record.state !== "released" &&
        row.record.admittedAttempt !== undefined &&
        !row.record.starts.some((start) => start.attempt === row.record.admittedAttempt && start.submitted),
    ).length,
    workspaceStarts: rows
      .flatMap((row) => row.record.starts)
      .filter((item) => item.submitted && new Date(item.claimedAt) >= start && new Date(item.claimedAt) < end).length,
    activeWorkspaces: rows.filter((row) => row.record.state !== "released").length,
  };
}
