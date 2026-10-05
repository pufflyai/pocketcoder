import { ApiError } from "@pstdio/pocketcoder-contracts";
import type {
  KeyListFilter,
  MachineKeyInsert,
  MachineKeyRow,
  PrincipalRow,
} from "@pstdio/pocketcoder-runtime-contracts";
import { assertKeyIssueAuthority } from "@pstdio/pocketcoder-runtime-core";
import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { requiredRow } from "../../database/required-row";
import { lockKeyAuthority } from "./authority";

function assertTargetGrants(principal: PrincipalRow, input: MachineKeyInsert) {
  if (principal.disabledAt) throw new ApiError("auth.disabled_principal", "This principal is disabled.");
  if (input.issuanceRequestId && input.expiresAt && input.expiresAt <= new Date())
    throw new ApiError("validation.invalid", "Key expiry must be in the future.");
  if (input.scopes.some((scope) => !principal.scopes.includes("admin") && !principal.scopes.includes(scope))) {
    throw new ApiError("auth.missing_scope", "Key scopes exceed the principal's authority.");
  }
  if (
    input.templateNames?.some(
      (name) => !principal.templateNames.includes("*") && !principal.templateNames.includes(name),
    )
  ) {
    throw new ApiError("template.not_authorized", "Key templates exceed the principal's authority.");
  }
}

export function createKeyInventory({ db, tables: { principals, machineKeys } }: DatabaseContext) {
  async function lockedPrincipal(tx: Transaction, input: MachineKeyInsert, actorKeyId?: string) {
    const actor = actorKeyId
      ? await lockKeyAuthority(
          tx,
          { principals, machineKeys },
          actorKeyId,
          input.principalId,
          input.managedPrincipalIds,
        )
      : null;
    const locked =
      actor?.locked ??
      (await tx
        .select()
        .from(principals)
        .where(inArray(principals.id, [input.principalId, ...(input.managedPrincipalIds ?? [])]))
        .orderBy(asc(principals.id))
        .for("update"));
    const principal = locked.find((row) => row.id === input.principalId);
    if (!principal) throw new ApiError("auth.invalid_key", "Unknown principal.");
    if (input.managedPrincipalIds?.some((id) => !locked.some((row) => row.id === id)))
      throw new ApiError("principal.not_found", "Unknown managed principal.");
    if (actor)
      assertKeyIssueAuthority(actor.authority, actor.key, principal, {
        scopes: input.scopes,
        templateNames: input.templateNames ?? principal.templateNames,
        expiresAt: input.expiresAt,
        managedPrincipalIds: input.managedPrincipalIds ?? [],
      });
    return principal;
  }

  async function issue(input: MachineKeyInsert, actorKeyId?: string) {
    return db.transaction(async (tx) => {
      const principal = await lockedPrincipal(tx, input, actorKeyId);
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
            principal,
            created: false,
            conflict: existing.issuanceRequestDigest !== input.issuanceRequestDigest,
          };
      }
      assertTargetGrants(principal, input);
      const [key] = await tx.insert(machineKeys).values(input).returning();
      return { key: requiredRow(key), principal, created: true, conflict: false };
    });
  }
  return {
    issueMachineKey: (input: MachineKeyRow, actorKeyId?: string) => issue(input, actorKeyId),
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
