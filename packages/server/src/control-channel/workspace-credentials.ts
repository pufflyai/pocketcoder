import {
  ApiError,
  managed,
  runtimeCredentialPath,
  sessionCredentialPath,
  templateCredentialReferences,
} from "@pstdio/pocketcoder-contracts";
import type { WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
import type { createWorkspaceLeaseService } from "../secrets/lease-service";
import type { WsDeps } from "./ws-types";

export function credentialDelivery(
  result: Awaited<ReturnType<ReturnType<typeof createWorkspaceLeaseService>["issue"]>>,
) {
  const session = result.lease.managedAuthority;
  return {
    lease_id: result.lease.id,
    // A session's lease is written under its own folder and named by its template slot.
    path: session
      ? sessionCredentialPath(session.sessionId, `secretRef:${session.slot}`)
      : runtimeCredentialPath(`secretRef:${result.lease.secretName}`),
    ...(session ? { session_id: session.sessionId } : {}),
    purpose: result.lease.purpose,
    credential: result.credential,
    expires_at: (result.lease.issuerExpiresAt ?? result.lease.requestExpiresAt).toISOString(),
  };
}

// A managed workspace receives credentials only for its bound sessions, never for the workspace.
const managedWorkspace = (row: WorkspaceRow) => Boolean(row.metadata?.[managed.MANAGED_SESSION_METADATA]);

// The latest live lease of every bound session and slot, replayed when the workspace (re)registers.
async function sessionCredentialsFor(
  service: ReturnType<typeof createWorkspaceLeaseService>,
  row: WorkspaceRow,
  leases: Awaited<ReturnType<WsDeps["store"]["listPendingWorkspaceLeases"]>>,
) {
  const pending = leases.filter(
    (lease) =>
      lease.managedAuthority &&
      ["issued", "delivered"].includes(lease.state) &&
      (lease.issuerExpiresAt ?? lease.requestExpiresAt) > new Date(),
  );
  const latest = new Map(
    pending.map((lease) => [`${lease.managedAuthority?.sessionId}:${lease.managedAuthority?.slot}`, lease]),
  );
  const credentials = [];
  for (const lease of latest.values()) credentials.push(credentialDelivery(await service.replay(row.id, lease.id)));
  return credentials;
}

export async function workspaceCredentialsFor(deps: WsDeps, row: WorkspaceRow) {
  const names = templateCredentialReferences(row.templateSnapshot);
  if (!names.length) return [];
  if (!deps.workspaceLeases) throw new ApiError("secret.unavailable", "Runtime issuer is unavailable.");
  const pending = await deps.store.listPendingWorkspaceLeases(row.id);
  const credentials = managedWorkspace(row) ? await sessionCredentialsFor(deps.workspaceLeases, row, pending) : [];
  for (const name of managedWorkspace(row) ? [] : names) {
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
