import { canonicalJson, type ExecutionRecord, type WorkloadExecutionReference } from "@pstdio/pocketcoder-contracts";
import type { WorkspaceRow } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq } from "drizzle-orm";
import type { DatabaseContext, QueryContext, Transaction } from "../../database/context";

export async function readExecution(
  context: DatabaseContext,
  tx: QueryContext,
  workspace: WorkspaceRow,
  execution: WorkloadExecutionReference,
) {
  if (execution.owner === "process") return sameExecution(workspace.processExecution, execution);
  const requests = context.tables.conversationRequests;
  const rows = await tx
    .select()
    .from(requests)
    .where(and(eq(requests.principalId, workspace.principalId), eq(requests.requestId, execution.requestId)));
  return rows.map((row) => sameExecution(row.execution, execution)).find(Boolean) ?? null;
}
function sameExecution(record: ExecutionRecord | null, execution: WorkloadExecutionReference) {
  return record && canonicalJson(record.acceptance.execution) === canonicalJson(execution) ? record : null;
}
export async function writeExecution(context: DatabaseContext, tx: Transaction, record: ExecutionRecord) {
  const { execution } = record.acceptance;
  if (execution.owner === "process") {
    await tx
      .update(context.tables.workspaces)
      .set({ processExecution: record })
      .where(eq(context.tables.workspaces.id, execution.workspaceId));
  } else {
    const requests = context.tables.conversationRequests;
    const rows = await tx
      .select()
      .from(requests)
      .where(
        and(eq(requests.principalId, record.acceptance.callerPrincipalId), eq(requests.requestId, execution.requestId)),
      );
    const row = rows.find((row) => sameExecution(row.execution, execution));
    if (!row) throw new Error("Execution owner missing");
    await tx
      .update(requests)
      .set({ execution: record })
      .where(
        and(
          eq(requests.principalId, record.acceptance.callerPrincipalId),
          eq(requests.requestId, execution.requestId),
          eq(requests.conversationId, row.conversationId),
        ),
      );
  }
}
