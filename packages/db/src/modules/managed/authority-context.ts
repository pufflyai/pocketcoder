import { ApiError, hasScope, type managed, type Scope } from "@pstdio/pocketcoder-contracts";
import { and, eq } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { lockKeyAuthority } from "../auth/authority";

export const unavailable = () => new ApiError("profile.not_found", "Execution authority is unavailable.");
export const conflict = () => new ApiError("idempotency.conflict", "The immutable identity has changed.");

export function authorityContext({ tables }: DatabaseContext) {
  const { managedProfiles: profiles, managedScopeGrants: grants, managedScopes: scopes } = tables;
  async function caller(tx: Transaction, keyId: string, scope: Scope, targetId?: string) {
    const found = await lockKeyAuthority(tx, tables, keyId, targetId);
    if (!hasScope(found.authority.scopes, scope))
      throw new ApiError("auth.missing_scope", `This operation requires ${scope}.`);
    return found;
  }
  async function scope(tx: Transaction, keyId: string, scopeId: string, write: boolean) {
    const actor = await caller(tx, keyId, write ? "budgets:admin" : "budgets:read");
    const [row] = await tx.select().from(scopes).where(eq(scopes.scopeId, scopeId));
    const [grant] = await tx
      .select()
      .from(grants)
      .where(and(eq(grants.scopeId, scopeId), eq(grants.principalId, actor.authority.principalId)));
    if (
      !row ||
      (!actor.authority.scopes.includes("admin") && (write ? row.principalId !== actor.authority.principalId : !grant))
    )
      throw new ApiError("budget.not_found", "Unknown budget scope.");
    return row;
  }
  async function profile(tx: Transaction, principalId: string, id: string, revision: number) {
    const [row] = await tx
      .select()
      .from(profiles)
      .where(and(eq(profiles.profileId, id), eq(profiles.revision, revision), eq(profiles.principalId, principalId)));
    if (!row) throw unavailable();
    return row;
  }
  async function validateScopes(tx: Transaction, principalId: string, profile: managed.ExecutionProfile) {
    const rows = await tx.select().from(scopes);
    const installation = rows.find((row) => row.installation);
    if (!installation || !profile.budgetScopeIds.includes(installation.scopeId)) throw unavailable();
    for (const id of profile.budgetScopeIds) {
      const [grant] = await tx
        .select()
        .from(grants)
        .where(and(eq(grants.scopeId, id), eq(grants.principalId, principalId)));
      if (!grant) throw unavailable();
    }
  }
  return { caller, scope, profile, validateScopes };
}
