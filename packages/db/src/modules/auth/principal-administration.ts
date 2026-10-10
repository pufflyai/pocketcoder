import { randomUUID } from "node:crypto";
import { ApiError } from "@pstdio/pocketcoder-contracts";
import type { PrincipalPatch, PrincipalRow } from "@pstdio/pocketcoder-runtime-contracts";
import { assertAuthorityScope, assertPrincipalWithinAuthority } from "@pstdio/pocketcoder-runtime-core";
import { eq } from "drizzle-orm";
import type { DatabaseContext } from "../../database/context";
import { requiredRow } from "../../database/required-row";
import type { JournalEvent } from "../../journal/events";
import { lockKeyAuthority } from "./authority";
import { revokeKeyIds, unrevokedKeyIds } from "./key-ids";

interface PrincipalChange {
  target: PrincipalRow;
  patch: PrincipalPatch;
  scopes: string[];
  templateNames: string[];
  keyIds: string[];
  at: Date;
}

// Restrictions are journaled before they commit and grants after, so a lost record
// can only leave a restored principal narrower than it was, never wider.
function principalEvents({ target, patch, scopes, templateNames, keyIds, at }: PrincipalChange) {
  const now: JournalEvent[] = [];
  const later: JournalEvent[] = [];
  const time = at.toISOString();
  if (patch.scopes || patch.templateNames) {
    const narrows =
      scopes.every((scope) => target.scopes.includes(scope)) &&
      templateNames.every((name) => target.templateNames.includes(name));
    (narrows ? now : later).push({ kind: "principal_access", principalId: target.id, scopes, templateNames, at: time });
  }
  if (patch.disabled === true) now.push({ kind: "principal_disabled", principalId: target.id, keyIds, at: time });
  if (patch.disabled === false) later.push({ kind: "principal_enabled", principalId: target.id, at: time });
  return { now, later };
}

export function createPrincipalAdministration({ db, journal, tables }: DatabaseContext) {
  const { principals, machineKeys } = tables;
  return {
    async createManagedPrincipal(actorKeyId: string, name: string, scopes: string[], templateNames: string[]) {
      return db.transaction(async (tx) => {
        const { authority } = await lockKeyAuthority(tx, { principals, machineKeys }, actorKeyId);
        assertAuthorityScope(authority, "principals:admin");
        assertPrincipalWithinAuthority(authority, { scopes, templateNames });
        const [row] = await tx
          .insert(principals)
          .values({ id: randomUUID(), name, scopes, templateNames, createdAt: new Date() })
          .onConflictDoNothing({ target: principals.name })
          .returning();
        if (!row) throw new ApiError("principal.name_conflict", "A principal with this name already exists.");
        return row;
      });
    },
    async updateManagedPrincipal(actorKeyId: string, id: string, patch: PrincipalPatch) {
      const later: JournalEvent[] = [];
      const updated = await db.transaction(async (tx) => {
        const { authority, target } = await lockKeyAuthority(tx, { principals, machineKeys }, actorKeyId, id);
        assertAuthorityScope(authority, "principals:admin");
        if (!target) throw new ApiError("principal.not_found", "Unknown principal.");
        if (target.id === authority.principalId)
          throw new ApiError("auth.missing_scope", "A calling key cannot edit its own principal.");
        assertPrincipalWithinAuthority(authority, target);
        const scopes = patch.scopes ?? target.scopes;
        const templateNames = patch.templateNames ?? target.templateNames;
        assertPrincipalWithinAuthority(authority, { scopes, templateNames });
        const at = new Date();
        const keyIds = await unrevokedKeyIds(tx, tables, id, patch.disabled === true);
        const events = principalEvents({ target, patch, scopes, templateNames, keyIds, at });
        for (const event of events.now) journal?.append(event);
        later.push(...events.later);
        const [row] = await tx
          .update(principals)
          .set({
            scopes,
            templateNames,
            ...(patch.disabled === undefined ? {} : { disabledAt: patch.disabled ? at : null }),
          })
          .where(eq(principals.id, id))
          .returning();
        await revokeKeyIds(tx, tables, keyIds, at);
        return requiredRow(row);
      });
      for (const event of later) journal?.append(event);
      return updated;
    },
  };
}
