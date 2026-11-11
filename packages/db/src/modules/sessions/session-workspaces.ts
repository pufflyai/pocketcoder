import { managed } from "@pstdio/pocketcoder-contracts";
import type { ManagedBinding, ManagedSessionIdentity } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq, sql } from "drizzle-orm";
import type { DatabaseContext, QueryContext } from "../../database/context";

// The compute a session owns alone: every workspace the placement owner created for it (found by
// its metadata, so a close that lands before the placement record still sees it) and its bound
// workspace, unless another session still runs there. Close must stop all of them.
export async function ownedWorkspaces(
  context: DatabaseContext,
  tx: QueryContext,
  id: ManagedSessionIdentity,
  binding: ManagedBinding | null,
) {
  const { workspaces, managedCapacity } = context.tables;
  const placed = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.principalId, id.principalId),
        sql`${workspaces.metadata}->>${managed.MANAGED_SESSION_METADATA} = ${id.sessionId}`,
      ),
    );
  const owned = new Set(placed.map((row) => row.id));
  if (binding) owned.add(binding.workspaceId);
  const capacity = await tx.select().from(managedCapacity);
  const shared = (workspaceId: string) =>
    capacity.some(
      (row) =>
        row.workspaceId === workspaceId &&
        row.record.sessions.some((s) => s.sessionId !== id.sessionId && !s.stoppedAt),
    );
  return [...owned].filter((workspaceId) => !shared(workspaceId));
}
