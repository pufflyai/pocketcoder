import { ApiError, runtimeCredentialPath, runtimeCredentialReferences } from "@pstdio/pocketcoder-contracts";
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

export async function workspaceCredentialsFor(deps: WsDeps, row: WorkspaceRow) {
  const names = runtimeCredentialReferences(row.templateSnapshot.spec);
  if (!names.length) return [];
  if (!deps.workspaceLeases) throw new ApiError("secret.unavailable", "Runtime issuer is unavailable.");
  const pending = await deps.store.listPendingWorkspaceLeases(row.id);
  const credentials = [];
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
