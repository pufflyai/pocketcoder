import { isNull } from "drizzle-orm";
import type { DatabaseContext, QueryContext } from "../../../database/context";

export async function inputIsPinned(context: DatabaseContext, tx: QueryContext, workspaceId: string, fileId: string) {
  const manifests = context.tables.inputManifests;
  const active = await tx.select().from(manifests).where(isNull(manifests.finalizedAt));
  return active.some(
    (row) =>
      row.manifest.workspaceId === workspaceId && row.manifest.objects.some((object) => object.fileId === fileId),
  );
}
