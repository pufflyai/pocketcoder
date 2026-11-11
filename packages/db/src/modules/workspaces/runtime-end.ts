import { executionSettled, type FiniteProcessFact } from "@pstdio/pocketcoder-contracts";
import { and, eq, sql } from "drizzle-orm";
import { type DatabaseContext, notifyChange, type Transaction } from "../../database/context";
import { lockStorageCapacity } from "../persistence/reservation-capacity";
import { retireUnsentRequest } from "../sessions/request-retirement";
import { settleExecutionFailure } from "./execution-failure";
import { lockExecutionSession } from "./execution-owners";

export async function endWorkspaceRuntime(context: DatabaseContext, id: string, incarnationId: string, at: Date) {
  const {
    db,
    tables: { workspaces, conversationRequests: requests },
  } = context;
  await db.transaction(async (tx) => {
    await lockStorageCapacity(context, tx);
    const [identity] = await tx
      .select({ principalId: workspaces.principalId })
      .from(workspaces)
      .where(eq(workspaces.id, id));
    if (!identity) return;
    const candidateRequests = await tx.select().from(requests).where(eq(requests.principalId, identity.principalId));
    for (const candidate of candidateRequests)
      if (candidate.execution?.acceptance.execution.workspaceId === id)
        await lockExecutionSession(context, tx, candidate.execution.acceptance.execution);
    const [row] = await tx.select().from(workspaces).where(eq(workspaces.id, id)).for("update");
    if (!row || row.runtimeRegistration?.incarnationId !== incarnationId || row.runtimeRegistration.endedAt) return;
    await endRequests(context, tx, row.principalId, id, incarnationId, at);
    const fact = row.finiteProcess;
    const uncertain = fact && fact.phase !== "exited" && fact.phase !== "lost";
    const endedFact: FiniteProcessFact | null = uncertain
      ? { ...fact, phase: "lost", endedAt: at.toISOString(), exitCode: null, signal: null }
      : fact;
    await tx
      .update(workspaces)
      .set({
        runtimeRegistration: { ...row.runtimeRegistration, endedAt: at.toISOString() },
        processExecution:
          row.processExecution && !executionSettled(row.processExecution)
            ? { ...row.processExecution, phase: "lost", settledAt: at.toISOString(), outcome: endedFact }
            : row.processExecution,
        finiteProcess: endedFact,
        changeSeq: sql`${workspaces.changeSeq}+1`,
        updatedAt: at,
      })
      .where(eq(workspaces.id, id));
  });
  notifyChange(context, id);
}

async function endRequests(
  context: DatabaseContext,
  tx: Transaction,
  principalId: string,
  id: string,
  incarnationId: string,
  at: Date,
) {
  const requests = context.tables.conversationRequests;
  const owned = await tx.select().from(requests).where(eq(requests.principalId, principalId));
  for (const request of owned) await endRequest(context, tx, request, id, incarnationId, at);
}
async function endRequest(
  context: DatabaseContext,
  tx: Transaction,
  request: DatabaseContext["tables"]["conversationRequests"]["$inferSelect"],
  id: string,
  incarnationId: string,
  at: Date,
) {
  const requests = context.tables.conversationRequests;
  const record = request.execution;
  if (
    !record ||
    record.acceptance.execution.workspaceId !== id ||
    record.acceptance.execution.incarnationId !== incarnationId ||
    (executionSettled(record) && record.finalizedAt)
  )
    return;
  if (request.managed) {
    if (await retireUnsentRequest(context, tx, request, record, at)) return;
    await settleExecutionFailure(context, tx, record, "runtime_lost", at, true);
    return;
  }
  await settleExecutionFailure(context, tx, record, "runtime_lost", at, true);
}
