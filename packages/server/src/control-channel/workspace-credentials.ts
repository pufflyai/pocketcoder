import { randomUUID } from "node:crypto";
import {
  ApiError,
  managed,
  runtimeCredentialPath,
  runtimeCredentialReferences,
  type WorkspaceCredential,
} from "@pstdio/pocketcoder-contracts";
import type { WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
import type { createWorkspaceLeaseService } from "../secrets/lease-service";
import type { WsDeps } from "./ws-types";

export function credentialDelivery(
  result: Awaited<ReturnType<ReturnType<typeof createWorkspaceLeaseService>["issue"]>>,
) {
  return {
    lease_id: result.lease.id,
    path: runtimeCredentialPath(`secretRef:${result.lease.secretName}`),
    purpose: result.lease.purpose,
    credential: result.credential,
    expires_at: (result.lease.issuerExpiresAt ?? result.lease.requestExpiresAt).toISOString(),
  };
}

export const MODEL_GATEWAY_CREDENTIAL_PATH = "/run/pocketcoder/secrets/leases/model-gateway";

// Only workspaces placed for managed sessions call the budgeted model gateway. The token proves
// this workspace incarnation and expires with it; the provider key never leaves the controller.
async function gatewayCredentials(deps: WsDeps, row: WorkspaceRow) {
  const incarnationId = row.runtimeRegistration?.incarnationId;
  if (!deps.modelGateway || !row.metadata[managed.MANAGED_SESSION_METADATA] || !incarnationId) return [];
  const grant = await deps.store.managed.grants.issue(row.id, incarnationId, new Date());
  return [
    {
      lease_id: randomUUID(),
      path: MODEL_GATEWAY_CREDENTIAL_PATH,
      purpose: "model-gateway" as const,
      credential: grant.token,
      expires_at: grant.expiresAt.toISOString(),
    },
  ];
}

export async function workspaceCredentialsFor(deps: WsDeps, row: WorkspaceRow) {
  const names = runtimeCredentialReferences(row.templateSnapshot.spec);
  const credentials: WorkspaceCredential[] = await gatewayCredentials(deps, row);
  if (!names.length) return credentials;
  if (!deps.workspaceLeases) throw new ApiError("secret.unavailable", "Runtime issuer is unavailable.");
  const pending = await deps.store.listPendingWorkspaceLeases(row.id);
  for (const name of names) {
    const previous = pending.findLast(
      (lease) =>
        lease.secretName === name &&
        lease.purpose === "runtime-issuer" &&
        ["requested", "issued", "delivered"].includes(lease.state) &&
        (lease.issuerExpiresAt ?? lease.requestExpiresAt) > new Date(),
    );
    const issued = previous
      ? await deps.workspaceLeases.replay(row.id, previous.id)
      : await deps.workspaceLeases.issue(row.id, name, "runtime-issuer");
    credentials.push(credentialDelivery(issued));
  }
  if (
    credentials.length > 64 ||
    credentials.reduce((sum, value) => sum + Buffer.byteLength(value.credential), 0) > 524_288
  )
    throw new ApiError("secret.unavailable", "Workspace credentials exceed delivery limits.");
  return credentials;
}
