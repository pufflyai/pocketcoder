import { type ExecutionRecord, executionInputManifestId, executionSettled } from "@pstdio/pocketcoder-contracts";
import type { DatabaseContext, Transaction } from "../../database/context";
import { finalizeInputManifest } from "../persistence/inputs/finalize";
import { settleExecutionFailure } from "./execution-failure";
import { managedExecutionOwner, writeExecution } from "./execution-owners";
import { executionConflict } from "./execution-validation";

// The caller holds the execution owner locks. An unclaimed execution ends here without dispatch;
// a claimed one keeps running until the producer reports its own terminal state.
export async function cancelExecution(
  context: DatabaseContext,
  tx: Transaction,
  record: ExecutionRecord,
  cancelId: string,
  at: Date,
) {
  if (record.cancel) {
    if (record.cancel.cancelId !== cancelId) executionConflict("Cancel identity conflict.");
    return record;
  }
  if (executionSettled(record)) return record;
  const next: ExecutionRecord = {
    ...record,
    cancel: { cancelId, requestedAt: at.toISOString() },
    ...(record.dispatchClaimedAt
      ? {}
      : { phase: "canceled", settledAt: at.toISOString(), finalizedAt: at.toISOString() }),
  };
  if (!record.dispatchClaimedAt && (await managedExecutionOwner(context, tx, record.acceptance.execution)))
    return settleExecutionFailure(context, tx, next, "canceled_before_dispatch", at);
  await writeExecution(context, tx, next);
  if (!record.dispatchClaimedAt)
    await finalizeInputManifest(context, tx, executionInputManifestId(record.acceptance), at);
  return next;
}
