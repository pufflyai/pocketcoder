import type { ManagedRequestRecord } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq } from "drizzle-orm";
import type { DatabaseContext, QueryContext } from "../../database/context";

export function withoutRequestContent(record: ManagedRequestRecord): ManagedRequestRecord {
  return { ...record, input: null, contentRemoved: true, request: { ...record.request, finalResponse: null } };
}
export async function removeRequestContent(
  context: DatabaseContext,
  tx: QueryContext,
  principalId: string,
  sessionId: string,
) {
  const requests = context.tables.conversationRequests;
  const rows = await tx
    .select()
    .from(requests)
    .where(and(eq(requests.principalId, principalId), eq(requests.conversationId, sessionId)));
  for (const row of rows) {
    if (!row.managed) continue;
    const managed = row.managed.queueReleased
      ? withoutRequestContent(row.managed)
      : { ...row.managed, contentRemoved: true };
    await tx
      .update(requests)
      .set({
        managed: { ...managed, request: { ...managed.request, revision: managed.request.revision + 1 } },
        ...(managed.queueReleased ? { execution: null } : {}),
      })
      .where(
        and(
          eq(requests.principalId, principalId),
          eq(requests.conversationId, sessionId),
          eq(requests.requestId, row.requestId),
        ),
      );
  }
  const observations = context.tables.managedObservations;
  await tx
    .delete(observations)
    .where(and(eq(observations.principalId, principalId), eq(observations.sessionId, sessionId)));
}
