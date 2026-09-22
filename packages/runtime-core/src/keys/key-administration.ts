import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { ApiError, digestOf, type KeyIssueRequest } from "@pstdio/pocketcoder-contracts";
import type { AuthStore, MachineKeyRow, PrincipalRow } from "../types";

export function keyResource(key: MachineKeyRow, principal: PrincipalRow) {
  const scopes = key.scopes.length ? key.scopes : principal.scopes;
  return {
    id: key.id,
    principal_id: key.principalId,
    scopes: key.scopes,
    effective_scopes: scopes.filter((scope) => principal.scopes.includes("admin") || principal.scopes.includes(scope)),
    managed_principal_ids: key.managedPrincipalIds,
    issuance_request_id: key.issuanceRequestId,
    created_at: key.createdAt.toISOString(),
    expires_at: key.expiresAt?.toISOString() ?? null,
    revoked_at: key.revokedAt?.toISOString() ?? null,
    last_used_at: key.lastUsedAt?.toISOString() ?? null,
  };
}

export async function issuePrincipalKey(
  store: AuthStore,
  pepper: string,
  principal: PrincipalRow,
  request: Omit<KeyIssueRequest, "expires_at"> & { expires_at: string | null },
  options: { managedPrincipalIds?: string[]; operatorBootstrap?: boolean } = {},
) {
  const scopes = [...new Set(request.scopes)].sort();
  const managedPrincipalIds = [...new Set(options.managedPrincipalIds ?? [])].sort();
  if (scopes.some((scope) => !(principal.scopes.includes("admin") || principal.scopes.includes(scope)))) {
    throw new ApiError("auth.missing_scope", "Key scopes exceed the principal's authority.");
  }
  if (
    !options.operatorBootstrap &&
    scopes.some((scope) => ["admin", "keys:read", "keys:write", "workspaces:recover"].includes(scope))
  ) {
    throw new ApiError("auth.missing_scope", "Delegated issuance cannot grant administrative authority.");
  }
  const expiresAt = request.expires_at ? new Date(request.expires_at) : null;
  if ((!expiresAt && !options.operatorBootstrap) || (expiresAt && !Number.isFinite(expiresAt.getTime())))
    throw new ApiError("validation.invalid", "Invalid key expiry.");
  if (managedPrincipalIds.length && (!options.operatorBootstrap || !principal.scopes.includes("admin"))) {
    throw new ApiError("auth.missing_scope", "Only an operator can bootstrap delegated authority.");
  }
  const generated = issueMachineKey(pepper);
  const result = await store.issueMachineKey({
    id: generated.id,
    secretDigest: generated.secretDigest,
    principalId: principal.id,
    scopes,
    managedPrincipalIds,
    issuanceRequestId: request.request_id,
    issuanceRequestDigest: digestOf({
      scopes,
      expires_at: expiresAt?.toISOString() ?? null,
      managed_principal_ids: managedPrincipalIds,
    }),
    createdAt: new Date(),
    expiresAt,
    revokedAt: null,
    lastUsedAt: null,
  });
  if (result.conflict) throw new ApiError("idempotency.conflict", "Changed key issuance request.");
  return {
    created: result.created,
    key: keyResource(result.key, principal),
    token: result.created ? generated.token : null,
  };
}
