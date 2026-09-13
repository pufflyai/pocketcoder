import type { CheckpointState } from "@pstdio/pocketcoder-contracts";
import type { WorkspaceCheckpointPatch, WorkspaceCheckpointRow } from "@pstdio/pocketcoder-runtime-contracts";
import { and, desc, eq } from "drizzle-orm";
import type { DatabaseContext } from "../../database/context";
import { requiredRow } from "../../database/required-row";

export function createCheckpoints({ db, tables: { workspaceCheckpoints: checkpoints } }: DatabaseContext) {
  async function getCheckpoint(id: string) {
    const [row] = await db.select().from(checkpoints).where(eq(checkpoints.id, id));
    return row ?? null;
  }
  return {
    getCheckpoint,
    async insertCheckpoint(input: WorkspaceCheckpointRow) {
      const [row] = await db
        .insert(checkpoints)
        .values(input)
        .onConflictDoUpdate({ target: checkpoints.id, set: { id: input.id } })
        .returning();
      return requiredRow(row);
    },
    async listCheckpoints(principalId: string, filter: { workspaceId?: string; state?: CheckpointState } = {}) {
      return db
        .select()
        .from(checkpoints)
        .where(
          and(
            eq(checkpoints.principalId, principalId),
            filter.workspaceId ? eq(checkpoints.workspaceId, filter.workspaceId) : undefined,
            filter.state ? eq(checkpoints.state, filter.state) : undefined,
          ),
        )
        .orderBy(desc(checkpoints.createdAt));
    },
    async updateCheckpoint(id: string, patch: WorkspaceCheckpointPatch, at: Date) {
      const current = await getCheckpoint(id);
      if (!current) return;
      if (
        current.state === "ready" &&
        Object.keys(patch).some((key) => !["state", "reasonCode", "expiresAt", "deletedAt"].includes(key))
      )
        throw new Error("ready checkpoints are immutable");
      await db
        .update(checkpoints)
        .set({ ...patch, updatedAt: at })
        .where(eq(checkpoints.id, id));
    },
  };
}
