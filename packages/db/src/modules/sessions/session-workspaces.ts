import { managed } from "@pstdio/pocketcoder-contracts";
import type { ManagedBinding, ManagedSessionIdentity } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq, sql } from "drizzle-orm";
import type { DatabaseContext, QueryContext } from "../../database/context";

// The compute a session owns alone: every workspace the placement owner created for it (found by
// its metadata, so a close that lands before the placement record still sees it), and the bound
// workspace of a credentialed session, which never shares. Close must stop all of them.
export async function ownedWorkspaces(
  context: DatabaseContext,
  tx: QueryContext,
  id: ManagedSessionIdentity,
  session: managed.Session,
  binding: ManagedBinding | null,
) {
  const { workspaces, managedProfiles: profiles } = context.tables;
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
  if (binding) {
    const [profile] = await tx
      .select({ profile: profiles.profile })
      .from(profiles)
      .where(
        and(
          eq(profiles.profileId, session.profileId),
          eq(profiles.revision, session.profileRevision),
          eq(profiles.principalId, id.principalId),
        ),
      );
    if (profile?.profile.credentialBindingId) owned.add(binding.workspaceId);
  }
  return [...owned];
}
