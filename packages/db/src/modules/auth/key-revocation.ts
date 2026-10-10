import { ApiError } from "@pstdio/pocketcoder-contracts";
import { assertAuthorityScope, principalWithinAuthority } from "@pstdio/pocketcoder-runtime-core";
import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { lockKeyAuthority } from "./authority";
import { revokeKeyIds, unrevokedKeyIds } from "./key-ids";

export function createKeyRevocation({ db, journal, tables }: DatabaseContext) {
  const { principals, machineKeys } = tables;
  async function lockTarget(tx: Transaction, principalId: string, actorKeyId?: string) {
    if (!actorKeyId) {
      await tx.select({ id: principals.id }).from(principals).where(eq(principals.id, principalId)).for("update");
      return;
    }
    const { authority, key, target } = await lockKeyAuthority(tx, { principals, machineKeys }, actorKeyId, principalId);
    assertAuthorityScope(authority, "keys:write");
    if (!target) throw new ApiError("principal.not_found", "Unknown principal.");
    // Exact recovery delegation remains valid for disabled targets.
    if (!authority.scopes.includes("admin") && key.managedPrincipalIds.length) {
      if (!key.managedPrincipalIds.includes(target.id)) throw new ApiError("principal.not_found", "Unknown principal.");
    } else if (!principalWithinAuthority(authority, target)) {
      throw new ApiError("principal.not_found", "Unknown principal.");
    }
  }

  return {
    async revokeMachineKey(keyId: string, at: Date, actorKeyId?: string) {
      return db.transaction(async (tx) => {
        const [identity] = await tx
          .select({ principalId: machineKeys.principalId })
          .from(machineKeys)
          .where(eq(machineKeys.id, keyId));
        if (!identity) return false;
        await lockTarget(tx, identity.principalId, actorKeyId);
        // Journal first: a restore must not revive a key whose revocation was ever requested.
        journal?.append({ kind: "key_revoked", keyId, at: at.toISOString() });
        const rows = await tx
          .update(machineKeys)
          .set({ revokedAt: at })
          .where(and(eq(machineKeys.id, keyId), isNull(machineKeys.revokedAt)))
          .returning({ id: machineKeys.id });
        return rows.length > 0;
      });
    },
    async revokePrincipalKeys(principalId: string, at: Date, actorKeyId?: string) {
      await db.transaction(async (tx) => {
        await lockTarget(tx, principalId, actorKeyId);
        const keyIds = await unrevokedKeyIds(tx, tables, principalId);
        journal?.append({ kind: "principal_disabled", principalId, keyIds, at: at.toISOString() });
        await tx.update(principals).set({ disabledAt: at }).where(eq(principals.id, principalId));
        await revokeKeyIds(tx, tables, keyIds, at);
      });
    },
  };
}
