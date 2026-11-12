import type { ManagedLeaseAuthority, WorkspaceRow } from "@pstdio/pocketcoder-runtime-contracts";
import { eq } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";

export async function managedLeaseActive(
  tx: Transaction,
  tables: DatabaseContext["tables"],
  owner: WorkspaceRow,
  authority: ManagedLeaseAuthority | null,
  _secretName: string,
  _secretVersionId: string | null,
  _at: Date,
) {
  const bound = await tx
    .select()
    .from(tables.managedSessions)
    .where(eq(tables.managedSessions.principalId, owner.principalId));
  const occupants = bound.filter((s) => s.binding?.workspaceId === owner.id);
  if (!authority) return occupants.length === 0;
  const [principal] = await tx.select().from(tables.principals).where(eq(tables.principals.id, authority.principalId));
  const session = occupants.find((s) => s.sessionId === authority.sessionId);
  return Boolean(
    principal &&
      !principal.disabledAt &&
      session &&
      !session.close &&
      session.session.reasonCode !== "credentials_refused" &&
      session.session.state !== "closed" &&
      session.binding?.generation === authority.generation &&
      session.binding.incarnationId === authority.incarnationId &&
      owner.runtimeRegistration?.incarnationId === authority.incarnationId &&
      session.session.profile === authority.profile &&
      session.session.owner === authority.owner &&
      session.session.group === authority.group,
  );
}
