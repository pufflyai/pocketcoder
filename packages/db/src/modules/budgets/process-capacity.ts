import { ApiError } from "@pstdio/pocketcoder-contracts";
import type { ManagedBinding, ManagedSessionIdentity } from "@pstdio/pocketcoder-runtime-contracts";
import { eq } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { authorityContext } from "../managed/authority-context";
import { sessionWriter } from "../sessions/observations";

export async function requireProcessCapacity(
  context: DatabaseContext,
  tx: Transaction,
  identity: ManagedSessionIdentity,
  binding: ManagedBinding,
  placing = false,
) {
  const table = context.tables.managedCapacity;
  const [row] = await tx.select().from(table).where(eq(table.workspaceId, binding.workspaceId));
  const session = await sessionWriter(context).read(tx, identity);
  const { profile } = await authorityContext(context).profile(tx, identity.principalId, session.session.profile);
  const participant = row?.record.sessions.find((session) => session.sessionId === identity.sessionId);
  if (
    !row ||
    row.record.state === "released" ||
    row.record.drainingAt ||
    (placing && row.record.templateDigest !== profile.templateDigest) ||
    !participant ||
    participant.generation !== binding.generation ||
    participant.stoppedAt
  )
    throw new ApiError("operation.conflict", "Session process capacity is unavailable.", {
      reason: "process_capacity_wait",
    });
}
