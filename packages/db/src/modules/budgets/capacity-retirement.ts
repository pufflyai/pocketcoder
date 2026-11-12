import type { ManagedSessionIdentity } from "@pstdio/pocketcoder-runtime-contracts";
import { eq } from "drizzle-orm";
import type { DatabaseContext } from "../../database/context";
import { lockStorageCapacity } from "../persistence/reservation-capacity";
import { sessionWriter } from "../sessions/observations";

export async function retireManagedWorkspace(context: DatabaseContext, id: ManagedSessionIdentity, at: Date) {
  const { db, tables } = context;
  return db.transaction(async (tx) => {
    await lockStorageCapacity(context, tx);
    await tx.select().from(tables.principals).where(eq(tables.principals.id, id.principalId)).for("update");
    const writer = sessionWriter(context),
      session = await writer.read(tx, id);
    if (!session.binding) return false;
    const [held] = await tx
      .select()
      .from(tables.managedCapacity)
      .where(eq(tables.managedCapacity.workspaceId, session.binding.workspaceId));
    if (!held || held.record.state === "released") return false;
    if (held.record.drainingAt) return true;
    const requests = await tx
      .select()
      .from(tables.conversationRequests)
      .where(eq(tables.conversationRequests.workspaceId, held.workspaceId));
    if (requests.some((r) => r.execution && !r.execution.finalizedAt)) return false;
    await tx
      .update(tables.managedCapacity)
      .set({ record: { ...held.record, drainingAt: at.toISOString() } })
      .where(eq(tables.managedCapacity.workspaceId, held.workspaceId));
    for (const s of held.record.sessions.filter((s) => !s.stoppedAt)) {
      const identity = { principalId: id.principalId, sessionId: s.sessionId },
        row = await writer.read(tx, identity);
      if (row.session.state !== "closed" && row.session.state !== "suspended")
        await writer.update(tx, identity, row.session.revision, "suspended", "workspace_draining");
    }
    return true;
  });
}
