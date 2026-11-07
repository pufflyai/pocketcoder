import { eq, isNotNull, isNull } from "drizzle-orm";
import type { DatabaseContext, QueryContext } from "../../../database/context";

export async function inputIsPinned(context: DatabaseContext, tx: QueryContext, workspaceId: string, fileId: string) {
  const registrations = await tx
    .select()
    .from(context.tables.sessionInputs)
    .where(eq(context.tables.sessionInputs.inputId, fileId));
  for (const registration of registrations.filter((row) => row.source.workspaceId === workspaceId)) {
    const requests = await tx
      .select()
      .from(context.tables.conversationRequests)
      .where(isNotNull(context.tables.conversationRequests.managed));
    if (
      requests.some(
        (row) =>
          row.principalId === registration.principalId &&
          row.conversationId === registration.sessionId &&
          row.managed &&
          !row.managed.queueReleased &&
          row.managed.input?.attachments.some((ref) => ref.inputId === fileId),
      )
    )
      return true;
  }
  const manifests = context.tables.inputManifests;
  const active = await tx.select().from(manifests).where(isNull(manifests.finalizedAt));
  return active.some(
    (row) =>
      row.manifest.workspaceId === workspaceId && row.manifest.objects.some((object) => object.fileId === fileId),
  );
}
