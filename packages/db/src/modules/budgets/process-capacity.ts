import { ApiError } from "@pstdio/pocketcoder-contracts";
import type { ManagedBinding, ManagedSessionIdentity } from "@pstdio/pocketcoder-runtime-contracts";
import { eq } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";

export async function requireProcessCapacity(
  context: DatabaseContext,
  tx: Transaction,
  identity: ManagedSessionIdentity,
  binding: ManagedBinding,
) {
  const table = context.tables.managedCapacity;
  const [row] = await tx.select().from(table).where(eq(table.workspaceId, binding.workspaceId));
  const participant = row?.record.sessions.find((session) => session.sessionId === identity.sessionId);
  if (
    !row ||
    row.record.state === "released" ||
    !participant ||
    participant.generation !== binding.generation ||
    participant.stoppedAt
  )
    throw new ApiError("operation.conflict", "Session process capacity is unavailable.", {
      reason: "process_capacity_wait",
    });
}
