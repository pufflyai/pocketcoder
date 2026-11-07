import { randomUUID } from "node:crypto";
import { canonicalJson, type ExecutionRecord } from "@pstdio/pocketcoder-contracts";
import type { ManagedRequestRecord } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { sessionWriter } from "./observations";
import { withoutRequestContent } from "./request-content";
import { requestObservation } from "./request-observation";

type RequestRow = DatabaseContext["tables"]["conversationRequests"]["$inferSelect"];
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
  if (canonicalJson(row.managed) === canonicalJson(next)) return;
  next = { ...next, request: { ...next.request, revision: next.request.revision + 1 } };
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
  const at = new Date().toISOString();
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
