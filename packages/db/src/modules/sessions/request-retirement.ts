import { type ExecutionRecord, executionInputManifestId } from "@pstdio/pocketcoder-contracts";
import { and, eq } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { finalizeInputManifest } from "../persistence/inputs/finalize";
import { writeManagedRequest } from "./request-writer";

export async function retireUnsentRequest(
  context: DatabaseContext,
  tx: Transaction,
  row: DatabaseContext["tables"]["conversationRequests"]["$inferSelect"],
  record: ExecutionRecord,
  at: Date,
) {
  if (!row.managed || record.producerSendClaimedAt || !["accepted", "dispatching"].includes(record.phase)) return false;
  await finalizeInputManifest(context, tx, executionInputManifestId(record.acceptance), at);
  const table = context.tables.conversationRequests;
  await tx
    .update(table)
    .set({ execution: null, workspaceId: null })
    .where(
      and(
        eq(table.principalId, row.principalId),
        eq(table.conversationId, row.conversationId),
        eq(table.requestId, row.requestId),
      ),
    );
  await writeManagedRequest(context, tx, row, {
    ...row.managed,
    bindingRevision: null,
    physicalExecution: undefined,
    attempts: [
      ...(row.managed.attempts ?? []),
      {
        execution: record.acceptance.execution,
        fingerprint: record.acceptance.fingerprint,
        bindingRevision: row.managed.bindingRevision,
        neverStartedAt: at.toISOString(),
      },
    ],
    request: {
      ...row.managed.request,
      state: "waiting",
      outcome: null,
      endedAt: null,
      reasonCode: "runtime_replacement_required",
    },
  });
  return true;
}
