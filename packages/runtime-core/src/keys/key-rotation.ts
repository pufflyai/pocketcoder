import { ApiError, digestOf, type KeyRotateRequest } from "@pstdio/pocketcoder-contracts";
import type { AuthStore, MachineKeyRow, PrincipalRow } from "../types";
import { issuePrincipalKey } from "./key-administration";

// The successor keeps the predecessor's lifetime, but no key may outlive the key that issues it.
export function successorExpiry(
  predecessor: Pick<MachineKeyRow, "createdAt"> & { expiresAt: Date },
  issuerExpiresAt: Date | null,
  now: Date,
) {
  const wanted = new Date(now.getTime() + predecessor.expiresAt.getTime() - predecessor.createdAt.getTime());
  return issuerExpiresAt && issuerExpiresAt < wanted ? issuerExpiresAt : wanted;
}

async function activePredecessor(store: AuthStore, principal: PrincipalRow, keyId: string, now: Date) {
  const found = await store.getMachineKeyWithPrincipal(keyId);
  if (!found || found.key.principalId !== principal.id) throw new ApiError("key.not_found", "Unknown key.");
  const { key } = found;
  if (key.revokedAt || !key.expiresAt || key.expiresAt <= now) {
    throw new ApiError("validation.invalid", "Only an active key with an expiry can be rotated.");
  }
  return { ...key, expiresAt: key.expiresAt };
}

// A successor is an ordinary key with the predecessor's grants, so the predecessor stays
// valid until the caller revokes it after the consumer has switched.
export async function rotatePrincipalKey(
  store: AuthStore,
  pepper: string,
  principal: PrincipalRow,
  keyId: string,
  request: KeyRotateRequest,
  options: { actorKeyId?: string; operatorBootstrap?: boolean } = {},
) {
  const now = new Date();
  // A replay reconciles through the stored request digest, even after the predecessor was revoked.
  const [replayed] = await store.listMachineKeys(principal.id, { limit: 1, requestId: request.request_id });
  const predecessor = replayed?.expiresAt
    ? { ...replayed, expiresAt: replayed.expiresAt }
    : await activePredecessor(store, principal, keyId, now);
  const issuer = options.actorKeyId ? await store.getMachineKeyWithPrincipal(options.actorKeyId) : null;
  const expiresAt =
    request.expires_at ?? successorExpiry(predecessor, issuer?.key.expiresAt ?? null, now).toISOString();
  return issuePrincipalKey(
    store,
    pepper,
    principal,
    {
      request_id: request.request_id,
      scopes: predecessor.scopes as never,
      ...(predecessor.templateNames ? { templates: predecessor.templateNames } : {}),
      ...(predecessor.managedPrincipalIds.length ? { managed_principal_ids: predecessor.managedPrincipalIds } : {}),
      expires_at: expiresAt,
    },
    { ...options, requestDigest: digestOf({ rotated_from: keyId, expires_at: request.expires_at ?? null }) },
  );
}
