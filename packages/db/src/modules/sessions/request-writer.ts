import { randomUUID } from "node:crypto";
import { canonicalJson, type ExecutionRecord } from "@pstdio/pocketcoder-contracts";
import type { ManagedRequestRecord } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { commitManagedHistory } from "./history-record";
import { sessionWriter } from "./observations";
import { withoutRequestContent } from "./request-content";
import { requestObservation } from "./request-observation";

type RequestRow = DatabaseContext["tables"]["conversationRequests"]["$inferSelect"];
type ManagedRecord = ManagedRequestRecord;
export async function writeManagedRequest(
  context: DatabaseContext,
  tx: Transaction,
  row: RequestRow,
  next: ManagedRequestRecord,
  finalized = false,
) {
  const writer = sessionWriter(context);
  const id = { principalId: row.principalId, sessionId: row.conversationId };
  const session = await writer.read(tx, id);
  const release =
    finalized &&
    !next.queueReleased &&
    next.request.state === "terminal" &&
    next.request.collection.state === "settled";
  const cleanupComplete = next.request.collection.cleanupState !== "pending";
  if (release && cleanupComplete) {
    next = { ...next, queueReleased: true };
    await tx
      .update(context.tables.managedSessions)
      .set({ queueCount: session.queueCount - 1, queueBytes: session.queueBytes - next.queueBytes })
      .where(writer.where(id));
  }
  if (next.queueReleased && next.contentRemoved) next = withoutRequestContent(next);
  const at = new Date().toISOString();
  next = stopFacts(next, at);
  if (canonicalJson(row.managed) === canonicalJson(next)) return;
  // Internal bookkeeping such as a cancel record does not change the public resource revision.
  const changed = canonicalJson(row.managed?.request) !== canonicalJson(next.request);
  if (changed) next = { ...next, request: { ...next.request, revision: next.request.revision + 1 } };
  const table = context.tables.conversationRequests;
  await tx
    .update(table)
    .set({ managed: next, ...(next.queueReleased && next.contentRemoved ? { execution: null } : {}) })
    .where(
      and(
        eq(table.principalId, row.principalId),
        eq(table.conversationId, row.conversationId),
        eq(table.requestId, row.requestId),
      ),
    );
  if (!changed) return;
  if (next.request.state === "terminal") await commitManagedHistory(context, tx, row, next);
  await writer.append(tx, id, {
    eventId: randomUUID(),
    cursor: `${id.sessionId}:${session.nextSequence}`,
    sessionId: id.sessionId,
    requestId: row.requestId,
    sequence: session.nextSequence,
    revision: next.request.revision,
    occurredAt: at,
    recordedAt: at,
    kind: "request.updated",
    data: next.request,
  });
}
// Facts from stop commands and the gateway that the producer cannot report itself.
function stopFacts(next: ManagedRecord, at: string): ManagedRecord {
  const { cancel, request } = next;
  if (request.state === "terminal") {
    const budget = next.budgetExhaustedAt && request.outcome !== "completed" && request.outcome !== "canceled";
    return {
      ...next,
      ...(cancel && !cancel.completedAt ? { cancel: { ...cancel, completedAt: at } } : {}),
      request: budget ? { ...request, reasonCode: "budget.exhausted" } : request,
    };
  }
  // A missed stop deadline stays pending; the request says why instead of claiming completion.
  if (cancel && !cancel.completedAt && cancel.cancelDeadline <= at)
    return { ...next, request: { ...request, reasonCode: "cancel_deadline_exceeded" } };
  return next;
}
export async function syncManagedExecution(
  context: DatabaseContext,
  tx: Transaction,
  row: RequestRow,
  record: ExecutionRecord,
) {
  if (!row.managed) return;
  const request = requestObservation(row.managed.request, record);
  await writeManagedRequest(context, tx, row, { ...row.managed, request }, record.finalizedAt !== null);
}
