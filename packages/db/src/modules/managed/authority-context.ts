import { ApiError, hasScope, type managed, type Scope } from "@pstdio/pocketcoder-contracts";
import { and, eq } from "drizzle-orm";
import { type DatabaseContext, lock, type Transaction } from "../../database/context";
import { lockKeyAuthority } from "../auth/authority";
import { storedProfile } from "./stored-records";

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
    await lock(tx, scopeId, 34);
    const [row] = await tx.select().from(scopes).where(eq(scopes.scopeId, scopeId)).for("update");
    const members = await tx.select().from(grants).where(eq(grants.scopeId, scopeId));
    const ownsPersonalScope =
      !row?.installation && members.length === 1 && row?.principalId === actor.authority.principalId;
    const hasGrant = members.some((grant) => grant.principalId === actor.authority.principalId);
    if (!row || (!actor.authority.scopes.includes("admin") && (write ? !ownsPersonalScope : !hasGrant)))
      throw new ApiError("budget.not_found", "Unknown budget scope.");
    return row;
  }
  async function profile(tx: Transaction, principalId: string, id: string, revision: number) {
    const [row] = await tx
      .select()
      .from(profiles)
      .where(and(eq(profiles.profileId, id), eq(profiles.revision, revision), eq(profiles.principalId, principalId)));
    if (!row) throw unavailable();
    return { ...row, profile: storedProfile(row.profile) };
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
