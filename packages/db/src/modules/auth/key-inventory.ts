import { ApiError } from "@pstdio/pocketcoder-contracts";
import type { KeyListFilter, MachineKeyInsert, MachineKeyRow } from "@pstdio/pocketcoder-runtime-contracts";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { DatabaseContext } from "../../database/context";
import { requiredRow } from "../../database/required-row";

export function createKeyInventory({ db, tables: { principals, machineKeys } }: DatabaseContext) {
  async function issue(input: MachineKeyInsert) {
    return db.transaction(async (tx) => {
      const [principal] = await tx.select().from(principals).where(eq(principals.id, input.principalId)).for("update");
      if (!principal) throw new ApiError("auth.invalid_key", "Unknown principal.");
      if (input.issuanceRequestId) {
        const [existing] = await tx
          .select()
          .from(machineKeys)
          .where(
            and(
              eq(machineKeys.principalId, input.principalId),
              eq(machineKeys.issuanceRequestId, input.issuanceRequestId),
            ),
          );
        if (existing)
          return {
            key: existing,
            created: false,
            conflict: existing.issuanceRequestDigest !== input.issuanceRequestDigest,
          };
      }
      if (principal.disabledAt) throw new ApiError("auth.disabled_principal", "This principal is disabled.");
      if (input.issuanceRequestId && input.expiresAt && input.expiresAt <= new Date())
        throw new ApiError("validation.invalid", "Key expiry must be in the future.");
      if (input.scopes.some((scope) => !principal.scopes.includes("admin") && !principal.scopes.includes(scope))) {
        throw new ApiError("auth.missing_scope", "Key scopes exceed the principal's authority.");
      }
      const [key] = await tx.insert(machineKeys).values(input).returning();
      return { key: requiredRow(key), created: true, conflict: false };
    });
  }
  return {
    issueMachineKey: (input: MachineKeyRow) => issue(input),
    async insertMachineKey(input: MachineKeyInsert) {
      await issue(input);
    },
    async listMachineKeys(principalId: string, filter: KeyListFilter) {
      return db
        .select()
        .from(machineKeys)
        .where(
          and(
            eq(machineKeys.principalId, principalId),
            filter.cursor ? gt(machineKeys.id, filter.cursor) : undefined,
            filter.requestId ? eq(machineKeys.issuanceRequestId, filter.requestId) : undefined,
          ),
        )
        .orderBy(asc(machineKeys.id))
        .limit(filter.limit);
    },
    async revokePrincipalKeys(principalId: string, at: Date) {
      await db.transaction(async (tx) => {
        await tx.select({ id: principals.id }).from(principals).where(eq(principals.id, principalId)).for("update");
        await tx.update(principals).set({ disabledAt: at }).where(eq(principals.id, principalId));
        await tx
          .update(machineKeys)
          .set({ revokedAt: at })
          .where(and(eq(machineKeys.principalId, principalId), isNull(machineKeys.revokedAt)));
      });
    },
  };
}
