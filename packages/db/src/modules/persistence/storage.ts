import type { WorkspaceStoragePatch, WorkspaceStorageRow } from "@pstdio/pocketcoder-runtime-contracts";
import { and, desc, eq, notInArray } from "drizzle-orm";
import type { DatabaseContext } from "../../database/context";

export function createStorage({ db, tables: { workspaceStorage: storage } }: DatabaseContext) {
  async function getWorkspaceStorage(workspaceId: string) {
    const [row] = await db
      .select()
      .from(storage)
      .where(and(eq(storage.workspaceId, workspaceId), notInArray(storage.state, ["deleted", "lost", "quarantined"])))
      .orderBy(desc(storage.createdAt))
      .limit(1);
    return row ?? null;
  }
  return {
    getWorkspaceStorage,
    async insertWorkspaceStorage(input: WorkspaceStorageRow) {
      const [row] = await db.insert(storage).values(input).onConflictDoNothing().returning();
      if (row) return row;
      const existing = await getWorkspaceStorage(input.workspaceId);
      if (!existing) throw new Error("workspace storage insert conflicted without a live row");
      return existing;
    },
    async getStorage(id: string) {
      const [row] = await db.select().from(storage).where(eq(storage.id, id));
      return row ?? null;
    },
    async updateWorkspaceStorage(id: string, patch: WorkspaceStoragePatch, at: Date) {
      await db
        .update(storage)
        .set({ ...patch, updatedAt: at })
        .where(eq(storage.id, id));
    },
  };
}
