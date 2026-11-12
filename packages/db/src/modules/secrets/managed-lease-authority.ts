import { digestOf } from "@pstdio/pocketcoder-contracts";
import type { ManagedLeaseAuthority, WorkspaceRow } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";

export async function managedLeaseActive(
  tx: Transaction,
  tables: DatabaseContext["tables"],
  owner: WorkspaceRow,
  authority: ManagedLeaseAuthority | null,
  secretName: string,
  secretVersionId: string,
  at: Date,
) {
  const { managedSessions: sessions, managedProfiles: profiles, managedCredentials: credentials, principals } = tables;
  const bound = await tx.select().from(sessions).where(eq(sessions.principalId, owner.principalId));
  const occupants = bound.filter((s) => s.binding?.workspaceId === owner.id);
  if (!authority) {
    for (const s of occupants) {
      const [p] = await tx
        .select()
        .from(profiles)
        .where(and(eq(profiles.profileId, s.session.profileId), eq(profiles.revision, s.session.profileRevision)));
      if (p?.profile.credentialBindingId) return false;
    }
    return true;
  }
  const [principal] = await tx.select().from(principals).where(eq(principals.id, authority.principalId));
  const session = occupants.find((s) => s.sessionId === authority.sessionId);
  const [profile] = await tx
    .select()
    .from(profiles)
    .where(and(eq(profiles.profileId, authority.profileId), eq(profiles.revision, authority.profileRevision)));
  const [registered] = await tx.select().from(credentials).where(eq(credentials.bindingId, authority.bindingId));
  if (!principal || principal.disabledAt || !session || !profile || !registered) return false;
  // Shared placement admits only sessions of this same profile, so every occupant holds equal authority.
  const sharing = occupants.some(
    (s) => s.session.profileId !== authority.profileId || s.session.profileRevision !== authority.profileRevision,
  );
  if (sharing || (occupants.length > 1 && profile.profile.credentialPlacement !== "shared")) return false;
  const binding = registered.binding;
  return (
    !["closed", "failed"].includes(session.session.state) &&
    session.binding?.generation === authority.generation &&
    session.binding.incarnationId === authority.incarnationId &&
    owner.runtimeRegistration?.incarnationId === authority.incarnationId &&
    session.session.profileId === authority.profileId &&
    session.session.profileRevision === authority.profileRevision &&
    profile.principalId === authority.principalId &&
    profile.profile.credentialBindingId === authority.bindingId &&
    binding.principalId === authority.principalId &&
    binding.secretName === secretName &&
    binding.secretVersionId === secretVersionId &&
    binding.slots.includes(authority.slot) &&
    profile.businessSlots.includes(authority.slot) &&
    digestOf(binding.authorityExpiresAt) === digestOf(authority.authorityExpiresAt) &&
    new Date(authority.authorityExpiresAt) > at
  );
}
