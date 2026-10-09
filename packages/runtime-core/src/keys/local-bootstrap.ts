import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { ApiError, digestOf, type KeyIssueRequest } from "@pstdio/pocketcoder-contracts";
import type { AuthStore } from "../types";
import { issuePrincipalKey, keyResource } from "./key-administration";

// Call these only from the local admin socket; filesystem permissions provide its authority.
export async function bootstrapLocalOwnerKey(
  store: AuthStore,
  pepper: string,
  input: Pick<KeyIssueRequest, "request_id" | "expires_at">,
  replace = false,
) {
  const expiresAt = new Date(input.expires_at);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date())
    throw new ApiError("validation.invalid", "Owner credentials require a future expiry.");
  const generated = issueMachineKey(pepper);
  const result = await store.bootstrapOwnerKey(
    {
      id: generated.id,
      secretDigest: generated.secretDigest,
      scopes: ["admin"],
      templateNames: ["*"],
      managedPrincipalIds: [],
      issuanceRequestId: input.request_id,
      issuanceRequestDigest: digestOf({ ...input, replace }),
      createdAt: new Date(),
      expiresAt,
      revokedAt: null,
      lastUsedAt: null,
    },
    replace,
  );
  if (result.conflict) throw new ApiError("idempotency.conflict", "Changed owner bootstrap request.");
  return { key: keyResource(result.key, result.principal), token: result.created ? generated.token : null };
}

export async function bootstrapLocalRecoveryKey(
  store: AuthStore,
  pepper: string,
  principalId: string,
  input: KeyIssueRequest,
) {
  if (
    !input.managed_principal_ids?.length ||
    !input.scopes.length ||
    input.scopes.some((scope) => !["keys:read", "keys:write", "workspaces:recover"].includes(scope))
  )
    throw new ApiError(
      "auth.missing_scope",
      "Recovery bootstrap requires exact targets and restricted recovery scopes.",
    );
  const principal = await store.getPrincipal(principalId);
  if (!principal) throw new ApiError("principal.not_found", "Unknown principal.");
  return issuePrincipalKey(store, pepper, principal, input, { operatorBootstrap: true });
}
