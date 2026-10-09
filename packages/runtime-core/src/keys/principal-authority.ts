import { ApiError, hasScope, type Scope } from "@pstdio/pocketcoder-contracts";
import type { MachineKeyRow, PrincipalRow } from "../types";

export function intersectTemplateGrants(principal: string[], key: string[] | null) {
  if (key === null) return principal;
  if (principal.includes("*")) return key;
  if (key.includes("*")) return principal;
  return key.filter((name) => principal.includes(name));
}

export function keyAuthority(principal: PrincipalRow, key: MachineKeyRow, at: Date) {
  if (key.revokedAt || (key.expiresAt && key.expiresAt <= at)) {
    throw new ApiError("auth.invalid_key", "This key is revoked or expired.");
  }
  if (principal.disabledAt) throw new ApiError("auth.disabled_principal", "This principal is disabled.");
  const scopes = key.scopes.length ? key.scopes : principal.scopes;
  return {
    principalId: principal.id,
    scopes: scopes.filter((scope) => principal.scopes.includes("admin") || principal.scopes.includes(scope)),
    templateNames: intersectTemplateGrants(principal.templateNames, key.templateNames),
    expiresAt: key.expiresAt,
  };
}

export type KeyAuthority = ReturnType<typeof keyAuthority>;

export function assertAuthorityScope(authority: KeyAuthority, scope: Scope) {
  if (!hasScope(authority.scopes, scope)) throw new ApiError("auth.missing_scope", `This operation requires ${scope}.`);
}

export function principalWithinAuthority(
  authority: Pick<KeyAuthority, "scopes" | "templateNames">,
  principal: Pick<PrincipalRow, "scopes" | "templateNames">,
) {
  return (
    (authority.scopes.includes("admin") || principal.scopes.every((scope) => authority.scopes.includes(scope))) &&
    principal.templateNames.every(
      (name) => authority.templateNames.includes("*") || authority.templateNames.includes(name),
    )
  );
}

export function assertPrincipalWithinAuthority(
  authority: KeyAuthority,
  principal: Pick<PrincipalRow, "scopes" | "templateNames">,
) {
  if (!principalWithinAuthority(authority, principal)) {
    throw new ApiError("auth.missing_scope", "Principal grants exceed the calling key's authority.");
  }
}

const RECOVERY_SCOPES = ["keys:read", "keys:write", "workspaces:recover"];
const ADMINISTRATION_SCOPES = ["admin", "principals:admin", ...RECOVERY_SCOPES];

export function assertKeyIssueAuthority(
  authority: KeyAuthority,
  caller: MachineKeyRow,
  target: PrincipalRow,
  request: Pick<MachineKeyRow, "scopes" | "templateNames" | "expiresAt" | "managedPrincipalIds">,
) {
  assertAuthorityScope(authority, "keys:write");
  if (!request.expiresAt || (authority.expiresAt && request.expiresAt > authority.expiresAt)) {
    throw new ApiError("auth.missing_scope", "Key expiry exceeds the calling key's remaining lifetime.");
  }
  const owner = authority.scopes.includes("admin");
  const delegated = caller.managedPrincipalIds.includes(target.id);
  if (!owner && delegated && target.scopes.some((scope) => ADMINISTRATION_SCOPES.includes(scope))) {
    throw new ApiError("auth.missing_scope", "Delegated issuance cannot target administrative authority.");
  }
  // Exact delegation authorizes the target's execution grants, while administrative grants require an owner.
  if (!owner && !delegated) assertPrincipalWithinAuthority(authority, target);
  if (!owner && delegated && request.scopes.some((scope) => ADMINISTRATION_SCOPES.includes(scope))) {
    throw new ApiError("auth.missing_scope", "Delegated issuance cannot grant administrative authority.");
  }
  if (!owner && !delegated && request.scopes.some((scope) => !authority.scopes.includes(scope))) {
    throw new ApiError("auth.missing_scope", "Requested scopes exceed the calling key's authority.");
  }
  const templateNames = request.templateNames ?? target.templateNames;
  const templateAuthority = { ...authority, scopes: ["admin"] };
  assertPrincipalWithinAuthority(templateAuthority, { scopes: [], templateNames });
  if (
    request.managedPrincipalIds.length &&
    (!owner || request.scopes.some((scope) => !RECOVERY_SCOPES.includes(scope)))
  ) {
    throw new ApiError("auth.missing_scope", "Only an owner may issue bounded recovery authority.");
  }
}
