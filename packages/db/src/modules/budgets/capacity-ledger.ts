import type { managed } from "@pstdio/pocketcoder-contracts";
import type { DatabaseContext, Transaction } from "../../database/context";
import { periodAt } from "./accounting";

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
