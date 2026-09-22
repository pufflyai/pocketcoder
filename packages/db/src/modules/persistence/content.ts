import { ApiError } from "@pstdio/pocketcoder-contracts";
import { eq } from "drizzle-orm";
import type { DatabaseContext, QueryContext } from "../../database/context";

// Writers and purge admission take the same row lock. A delayed write cannot
// commit after the deletion fence or race the final database cleanup.
export async function contentWritable(tx: QueryContext, tables: DatabaseContext["tables"], workspaceId: string) {
  const [workspace] = await tx
    .select({ purgeRequestedAt: tables.workspaces.purgeRequestedAt })
    .from(tables.workspaces)
    .where(eq(tables.workspaces.id, workspaceId))
    .for("update");
  return !workspace?.purgeRequestedAt;
}

export async function requireContentWritable(tx: QueryContext, tables: DatabaseContext["tables"], workspaceId: string) {
  if (!(await contentWritable(tx, tables, workspaceId))) {
    throw new ApiError("operation.conflict", "Workspace content is being purged.");
  }
}

export function createContentPurge({ db, tables }: DatabaseContext) {
  return {
    async listWorkspaceStorage(workspaceId: string) {
      return db.select().from(tables.workspaceStorage).where(eq(tables.workspaceStorage.workspaceId, workspaceId));
    },
    async purgeWorkspaceContent(workspaceId: string, at: Date) {
      await db.transaction(async (tx) => {
        const [workspace] = await tx
          .select()
          .from(tables.workspaces)
          .where(eq(tables.workspaces.id, workspaceId))
          .for("update");
        if (!workspace?.purgeRequestedAt) throw new Error("Purge has not been admitted");
        for (const table of [
          tables.workspaceLogs,
          tables.workspaceOutputs,
          tables.workspaceConversationMessages,
          tables.workspaceNetworkEvents,
          tables.eventOutbox,
        ]) {
          await tx.delete(table).where(eq(table.workspaceId, workspaceId));
        }
        await tx
          .insert(tables.workspaceConversations)
          .values({ workspaceId, status: "deleted", deletedAt: at, updatedAt: at })
          .onConflictDoUpdate({
            target: tables.workspaceConversations.workspaceId,
            set: { status: "deleted", expiresAt: null, deletedAt: at, updatedAt: at },
          });
        await tx
          .update(tables.workspaceCheckpoints)
          .set({ manifest: null, manifestDigest: null, sourceProvenance: null, label: null })
          .where(eq(tables.workspaceCheckpoints.workspaceId, workspaceId));
        await tx
          .update(tables.workspaces)
          .set({
            launchInput: null,
            outputs: {},
            metadata: {},
            health: {},
            failureLogTail: null,
            failureLogTailTruncated: false,
            failureLastLogSeq: null,
            sourceDescriptor: null,
            resolvedSource: null,
            registrationDigest: null,
            reconnectDigest: null,
            updatedAt: at,
          })
          .where(eq(tables.workspaces.id, workspaceId));
      });
    },
  };
}
