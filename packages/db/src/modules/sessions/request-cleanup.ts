import { eq, isNotNull } from "drizzle-orm";
import type { DatabaseContext } from "../../database/context";
import { lockStorageCapacity } from "../persistence/reservation-capacity";
import { lockExecutionSession, readExecution, writeExecution } from "../workspaces/execution-owners";

// The lifecycle owner calls this after its driver has removed physical projections.
export async function completeManagedCleanup(context: DatabaseContext, workspaceId: string) {
  const { db, tables } = context;
  const rows = await db
    .select()
    .from(tables.conversationRequests)
    .where(isNotNull(tables.conversationRequests.execution));
  for (const row of rows) {
    const target = row.execution?.acceptance.execution;
    if (!target || target.workspaceId !== workspaceId) continue;
    await db.transaction(async (tx) => {
      await lockStorageCapacity(context, tx);
      await lockExecutionSession(context, tx, target);
      const [workspace] = await tx
        .select()
        .from(tables.workspaces)
        .where(eq(tables.workspaces.id, workspaceId))
        .for("update");
      if (!workspace) return;
      const record = await readExecution(context, tx, workspace, target);
      if (record?.finalizationBasis !== "runtime_fenced" || record.collection?.cleanupState !== "pending") return;
      await writeExecution(context, tx, { ...record, collection: { ...record.collection, cleanupState: "complete" } });
    });
  }
}
