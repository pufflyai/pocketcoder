import {
  ApiError,
  managed,
  runtimeCredentialPath,
  sessionCredentialPath,
  templateCredentialReferences,
} from "@pstdio/pocketcoder-contracts";
import type { WorkspaceLeaseRow, WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
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

// The newest lease of every session and slot. A renewal is requested only after its predecessor
// was delivered, so it is created later; the later deadline settles equal timestamps.
export function latestSessionLeases<T extends WorkspaceLeaseRow>(leases: T[]) {
  const latest = new Map<string, T>();
  const order = (lease: T) => [lease.createdAt.getTime(), lease.requestExpiresAt.getTime()] as const;
  for (const lease of leases) {
    const key = `${lease.managedAuthority?.sessionId}:${lease.managedAuthority?.slot}`;
    const known = latest.get(key);
    const [created, deadline] = order(lease);
    if (!known || created > order(known)[0] || (created === order(known)[0] && deadline > order(known)[1]))
      latest.set(key, lease);
  }
  return [...latest.values()];
}

// Every bound session's newest live lease, replayed when the workspace (re)registers.
async function sessionCredentialsFor(
  service: ReturnType<typeof createWorkspaceLeaseService>,
  row: WorkspaceRow,
  leases: WorkspaceLeaseRow[],
) {
  const pending = leases.filter(
    (lease) =>
      lease.managedAuthority &&
      ["issued", "delivered"].includes(lease.state) &&
      (lease.issuerExpiresAt ?? lease.requestExpiresAt) > new Date(),
  );
  const credentials = [];
  for (const lease of latestSessionLeases(pending))
    credentials.push(credentialDelivery(await service.replay(row.id, lease.id)));
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
