import { ApiError, type managed, type WorkloadExportReference } from "@pstdio/pocketcoder-contracts";
import { and, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { workAuthority } from "./work-authority";

export function mappedCollection(
  sessionId: string,
  requestId: string,
  collection: WorkloadExportReference,
): managed.CollectionResult {
  return {
    sessionId,
    requestId,
    revision: 1,
    state: "settled",
    completeness: collection.completeness,
    manifestDigest: collection.manifestDigest,
    settledAt: collection.publishedAt,
    expiresAt: collection.expiresAt,
    errors: collection.errors,
    cleanupState: collection.cleanupState ?? "not_required",
    objects: collection.objects.map((object) => ({
      sessionId,
      requestId,
      exportId: object.objectId,
      versionId: object.objectId,
      sha256: object.digest,
      name: object.name,
      mediaType: object.mediaType,
      sizeBytes: object.sizeBytes,
      completeness: collection.completeness === "complete" ? "complete" : "partial",
      availability: collection.publication,
      expiresAt: collection.expiresAt,
    })),
  };
}
export async function availableCollection(
  context: DatabaseContext,
  tx: Transaction,
  collection: managed.CollectionResult,
) {
  if (!collection.objects.length) return collection;
  const table = context.tables.exportObjects;
  const rows = await tx
    .select()
    .from(table)
    .where(
      inArray(
        table.id,
        collection.objects.map((object) => object.exportId),
      ),
    );
  const objects = collection.objects.map((object) => {
    const stored = rows.find((row) => row.id === object.exportId);
    let availability: managed.ExportObject["availability"] = "published";
    if (new Date(object.expiresAt) <= new Date()) availability = "expired";
    else if (!stored?.data || stored.deletedAt) availability = "unavailable";
    return { ...object, availability };
  });
  return { ...collection, objects };
}
export function logicalExports(context: DatabaseContext) {
  const { db, tables } = context;
  const authorize = workAuthority(context);
  return {
    async exports(keyId: string, sessionId: string, requestId?: string) {
      return db.transaction(async (tx) => {
        const { id } = await authorize(tx, keyId, sessionId, "sessions:read");
        const rows = await tx
          .select()
          .from(tables.conversationRequests)
          .where(
            and(
              eq(tables.conversationRequests.principalId, id.principalId),
              eq(tables.conversationRequests.conversationId, sessionId),
              isNotNull(tables.conversationRequests.managed),
            ),
          );
        const result: managed.ExportObject[] = [];
        for (const row of rows.filter((row) => !requestId || row.requestId === requestId)) {
          if (row.managed)
            result.push(...(await availableCollection(context, tx, row.managed.request.collection)).objects);
        }
        return result;
      });
    },
    async content(keyId: string, sessionId: string, exportId: string) {
      return db.transaction(async (tx) => {
        const { id } = await authorize(tx, keyId, sessionId, "sessions:read");
        const objects = tables.exportObjects;
        const requests = await tx
          .select()
          .from(tables.conversationRequests)
          .where(
            and(
              eq(tables.conversationRequests.principalId, id.principalId),
              eq(tables.conversationRequests.conversationId, sessionId),
            ),
          );
        if (
          !requests.some(
            (row) =>
              row.managed?.request.collection.state === "settled" &&
              row.managed.request.collection.objects.some((object) => object.exportId === exportId),
          )
        )
          throw new ApiError("artifact.not_found", "Retained result is unavailable.");
        const [row] = await tx
          .select()
          .from(objects)
          .where(
            and(
              eq(objects.id, exportId),
              eq(objects.principalId, id.principalId),
              eq(objects.sessionId, sessionId),
              isNull(objects.deletedAt),
              gt(objects.expiresAt, new Date()),
            ),
          );
        if (!row?.data) throw new ApiError("artifact.not_found", "Retained result is unavailable.");
        return row.data;
      });
    },
  };
}
