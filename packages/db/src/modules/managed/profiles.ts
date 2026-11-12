import { templateCredentialReferences } from "@pstdio/pocketcoder-contracts";
import type { ManagedProfileStore } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq } from "drizzle-orm";
import type { DatabaseContext, QueryContext } from "../../database/context";
import { authorityContext, unavailable } from "./authority-context";
import { profileReconciliation } from "./profile-reconciliation";

export function createManagedProfiles(context: DatabaseContext): ManagedProfileStore {
  const { db, tables } = context;
  const issuers = tables.managedIssuers;
  const auth = authorityContext(context);
  async function issuer(principalId: string, name: string, query: QueryContext = db) {
    const [row] = await query
      .select()
      .from(issuers)
      .where(and(eq(issuers.principalId, principalId), eq(issuers.name, name)));
    if (!row) throw unavailable();
    return row.config;
  }
  return {
    issuer,
    reconcile: profileReconciliation(context),
    async get(keyId, name) {
      return db.transaction(async (tx) => {
        const actor = await auth.caller(tx, keyId, "sessions:read");
        const { profile } = await auth.profile(tx, actor.authority.principalId, name);
        if (!actor.authority.templateNames.some((n) => n === "*" || n === profile.template)) throw unavailable();
        const { templateDigest: _digest, businessSlots: _slots, ...resource } = profile;
        return resource;
      });
    },
    async leaseAuthority(identity, workspaceId, generation, slot) {
      return db.transaction(async (tx) => {
        const s = tables.managedSessions;
        const [session] = await tx
          .select()
          .from(s)
          .where(and(eq(s.principalId, identity.principalId), eq(s.sessionId, identity.sessionId)))
          .for("update");
        if (
          !session ||
          session.close ||
          session.session.reasonCode === "credentials_refused" ||
          ["closed", "failed"].includes(session.session.state) ||
          session.binding?.workspaceId !== workspaceId ||
          session.binding.generation !== generation
        )
          throw unavailable();
        const { profile } = await auth.profile(tx, identity.principalId, session.session.profile);
        const [workspace] = await tx.select().from(tables.workspaces).where(eq(tables.workspaces.id, workspaceId));
        const slots = workspace ? templateCredentialReferences(workspace.templateSnapshot) : [];
        if (!profile.issuer || !slots.includes(slot)) throw unavailable();
        const config = await issuer(identity.principalId, profile.issuer, tx);
        return {
          issuer: config,
          authority: {
            ...identity,
            profile: profile.name,
            owner: session.session.owner,
            group: session.session.group,
            generation,
            incarnationId: session.binding.incarnationId,
            slot,
            issuer: profile.issuer,
          },
        };
      });
    },
  };
}
