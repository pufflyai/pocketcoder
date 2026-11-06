import { digestOf, managed, runtimeCredentialReferences } from "@pstdio/pocketcoder-contracts";
import type { ManagedAuthorityStore, ManagedSessionIdentity } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq } from "drizzle-orm";
import { type DatabaseContext, lock } from "../../database/context";
import { authorityContext, conflict, unavailable } from "./authority-context";
import { credentialBindings } from "./credential-bindings";

export function createManagedAuthority(context: DatabaseContext): ManagedAuthorityStore {
  const { db, tables } = context;
  const {
    managedProfiles: profiles,
    managedScopes: scopes,
    managedScopeGrants: grants,
    managedCredentials: credentials,
    templates,
    managedSessions: sessions,
    workspaces,
  } = tables;
  const auth = authorityContext(context);
  async function credentialSlots(
    tx: import("../../database/context").Transaction,
    principalId: string,
    profile: managed.ExecutionProfile,
    slots: string[],
  ) {
    if (!slots.length && !profile.credentialBindingId) return;
    if (!profile.credentialBindingId) throw unavailable();
    const [row] = await tx.select().from(credentials).where(eq(credentials.bindingId, profile.credentialBindingId));
    if (!row || row.binding.principalId !== principalId || new Date(row.binding.authorityExpiresAt) <= new Date())
      throw unavailable();
    if (slots.some((slot) => !row.binding.slots.includes(slot))) throw unavailable();
  }
  return {
    async registerScope(keyId, scopeId, principalId, installation = false) {
      await db.transaction(async (tx) => {
        const actor = await auth.caller(tx, keyId, "admin", principalId);
        if (!actor.target || actor.target.disabledAt) throw unavailable();
        await lock(tx, "managed-scope-registration", 30);
        const [known] = await tx.select().from(scopes).where(eq(scopes.scopeId, scopeId));
        if (known && known.installation !== installation) throw conflict();
        if (!known) {
          if (installation && (await tx.select().from(scopes).where(eq(scopes.installation, true))).length)
            throw conflict();
          await tx.insert(scopes).values({ scopeId, principalId, installation, lastClockAt: new Date() });
        }
        await tx.insert(grants).values({ scopeId, principalId }).onConflictDoNothing();
      });
    },
    registerCredential: credentialBindings(context),
    async provisionProfile(keyId, principalId, input) {
      const profile = managed.ExecutionProfileSchema.parse(input);
      profile.budgetScopeIds.sort();
      profile.allowedModels.sort();
      return db.transaction(async (tx) => {
        const actor = await auth.caller(tx, keyId, "admin", principalId);
        if (!actor.target || actor.target.disabledAt) throw unavailable();
        await auth.validateScopes(tx, principalId, profile);
        const [template] = await tx.select().from(templates).where(eq(templates.digest, profile.templateDigest));
        if (!template || !actor.target.templateNames.some((name) => name === "*" || name === template.name))
          throw unavailable();
        const slots = runtimeCredentialReferences(template.spec);
        await credentialSlots(tx, principalId, profile, slots);
        await lock(tx, profile.profileId, 32);
        const [known] = await tx
          .select()
          .from(profiles)
          .where(and(eq(profiles.profileId, profile.profileId), eq(profiles.revision, profile.revision)));
        if (known) {
          if (known.principalId !== principalId || digestOf(known.profile) !== digestOf(profile)) throw conflict();
          return known.profile;
        }
        await tx.insert(profiles).values({
          profileId: profile.profileId,
          revision: profile.revision,
          principalId,
          profile,
          businessSlots: slots,
        });
        return profile;
      });
    },
    async profile(keyId, id, revision) {
      return db.transaction(async (tx) => {
        const actor = await auth.caller(tx, keyId, "sessions:read");
        const row = await auth.profile(tx, actor.authority.principalId, id, revision);
        await auth.validateScopes(tx, row.principalId, row.profile);
        return row.profile;
      });
    },
    async leaseAuthority(identity: ManagedSessionIdentity, workspaceId, generation, slot) {
      return db.transaction(async (tx) => {
        const [session] = await tx
          .select()
          .from(sessions)
          .where(and(eq(sessions.principalId, identity.principalId), eq(sessions.sessionId, identity.sessionId)))
          .for("update");
        if (
          !session ||
          ["closed", "failed"].includes(session.session.state) ||
          session.binding?.workspaceId !== workspaceId ||
          session.binding.generation !== generation
        )
          throw unavailable();
        const owner = await auth.profile(
          tx,
          identity.principalId,
          session.session.profileId,
          session.session.profileRevision,
        );
        if (!owner.businessSlots.includes(slot)) throw unavailable();
        const profile = owner.profile;
        const [binding] = profile.credentialBindingId
          ? await tx.select().from(credentials).where(eq(credentials.bindingId, profile.credentialBindingId))
          : [];
        const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
        if (
          !binding ||
          !workspace ||
          workspace.principalId !== identity.principalId ||
          !binding.binding.slots.includes(slot) ||
          new Date(binding.binding.authorityExpiresAt) <= new Date()
        )
          throw unavailable();
        return {
          secretName: binding.binding.secretName,
          secretVersionId: binding.binding.secretVersionId,
          authority: {
            ...identity,
            profileId: profile.profileId,
            profileRevision: profile.revision,
            generation,
            incarnationId: session.binding.incarnationId,
            bindingId: binding.bindingId,
            slot,
            authorityExpiresAt: binding.binding.authorityExpiresAt,
          },
        };
      });
    },
  };
}
