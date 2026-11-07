import { canonicalJson, type ExecutionRecord, type WorkloadExecutionReference } from "@pstdio/pocketcoder-contracts";
import type { WorkspaceRow } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq, or, sql } from "drizzle-orm";
import type { DatabaseContext, QueryContext, Transaction } from "../../database/context";
import { sessionWriter } from "../sessions/observations";
import { syncManagedExecution } from "../sessions/request-writer";

function physicalRequest(context: DatabaseContext, requestId: string) {
  const table = context.tables.conversationRequests;
  return or(eq(table.requestId, requestId), eq(sql<string>`${table.identity}->>'turn_id'`, requestId));
}
export async function lockExecutionSession(
  context: DatabaseContext,
  tx: Transaction,
  execution: WorkloadExecutionReference,
) {
  const row = await managedExecutionOwner(context, tx, execution);
  if (!row) return;
  await tx
    .select()
    .from(context.tables.principals)
    .where(eq(context.tables.principals.id, row.principalId))
    .for("update");
  await sessionWriter(context).read(tx, { principalId: row.principalId, sessionId: row.conversationId });
}
export async function managedExecutionOwner(
  context: DatabaseContext,
  tx: QueryContext,
  execution: WorkloadExecutionReference,
) {
  if (execution.owner === "process") return null;
  const table = context.tables.conversationRequests;
  const rows = await tx.select().from(table).where(physicalRequest(context, execution.requestId));
  return rows.find((row) => row.managed && sameExecution(row.execution, execution)) ?? null;
}

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
    .where(and(eq(requests.principalId, workspace.principalId), physicalRequest(context, execution.requestId)));
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
        and(
          eq(requests.principalId, record.acceptance.callerPrincipalId),
          physicalRequest(context, execution.requestId),
        ),
      );
    const row = rows.find((row) => sameExecution(row.execution, execution));
    if (!row) throw new Error("Execution owner missing");
    await tx
      .update(requests)
      .set({ execution: record })
      .where(
        and(
          eq(requests.principalId, record.acceptance.callerPrincipalId),
          eq(requests.requestId, row.requestId),
          eq(requests.conversationId, row.conversationId),
        ),
      );
    await syncManagedExecution(context, tx, row, record);
  }
}
