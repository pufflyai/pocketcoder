import { randomUUID } from "node:crypto";
import { ApiError } from "@pstdio/pocketcoder-contracts";
import type { PrincipalPatch } from "@pstdio/pocketcoder-runtime-contracts";
import { assertAuthorityScope, assertPrincipalWithinAuthority } from "@pstdio/pocketcoder-runtime-core";
import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseContext } from "../../database/context";
import { requiredRow } from "../../database/required-row";
import { lockKeyAuthority } from "./authority";

export function createPrincipalAdministration({ db, tables: { principals, machineKeys } }: DatabaseContext) {
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
      return db.transaction(async (tx) => {
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
        const [row] = await tx
          .update(principals)
          .set({
            scopes,
            templateNames,
            ...(patch.disabled === undefined ? {} : { disabledAt: patch.disabled ? at : null }),
          })
          .where(eq(principals.id, id))
          .returning();
        if (patch.disabled)
          await tx
            .update(machineKeys)
            .set({ revokedAt: at })
            .where(and(eq(machineKeys.principalId, id), isNull(machineKeys.revokedAt)));
        return requiredRow(row);
      });
    },
  };
}
