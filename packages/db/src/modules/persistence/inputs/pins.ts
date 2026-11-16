import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseContext, QueryContext } from "../../../database/context";

export async function inputIsPinned(context: DatabaseContext, tx: QueryContext, workspaceId: string, fileId: string) {
  const registrations = await tx
    .select()
    .from(context.tables.sessionInputs)
    .where(eq(context.tables.sessionInputs.inputId, fileId));
  for (const registration of registrations.filter((row) => row.source.workspaceId === workspaceId)) {
    const sessions = context.tables.managedSessions;
    const [session] = await tx
      .select()
      .from(sessions)
      .where(and(eq(sessions.principalId, registration.principalId), eq(sessions.sessionId, registration.sessionId)));
    const requestsTable = context.tables.conversationRequests;
    const requests = await tx
      .select()
      .from(requestsTable)
      .where(
        and(
          eq(requestsTable.principalId, registration.principalId),
          eq(requestsTable.conversationId, registration.sessionId),
        ),
      );
    if (
      requests.some(
        (row) =>
          row.principalId === registration.principalId &&
          row.conversationId === registration.sessionId &&
          row.managed &&
          (!row.managed.queueReleased || (session && !session.close && !row.managed.contentRemoved)) &&
          row.managed.input?.attachments.includes(fileId),
      )
    )
      return true;
  }
  const manifests = context.tables.inputManifests;
  const active = await tx.select().from(manifests).where(isNull(manifests.finalizedAt));
  return active.some((row) =>
    row.manifest.objects.some(
      (object) => (object.storageOwnerId ?? row.manifest.workspaceId) === workspaceId && object.fileId === fileId,
    ),
  );
}
