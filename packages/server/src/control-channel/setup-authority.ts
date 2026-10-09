import type { Store, WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
import type { LiveConnection } from "./hub";
import { sourceCredentialReference } from "./ws-auth";
import type { WsDeps } from "./ws-types";

export async function setupAuthorityClosed(store: Store, row: WorkspaceRow) {
  const reference = sourceCredentialReference(row);
  if (!reference) return true;
  const leases = await store.listWorkspaceLeases(row.id);
  return (
    leases.some((lease) => lease.secretName === reference.slice(10) && lease.deliveredAt !== null) &&
    leases.every((lease) => lease.state === "revoked" || lease.state === "expired")
  );
}

export async function completeSourceSetup(deps: WsDeps, connection: LiveConnection, requestId: string) {
  const row = await deps.store.getWorkspace(connection.workspaceId);
  if (
    row?.state !== "connected" ||
    row.purgeRequestedAt ||
    row.deadlineAt <= new Date() ||
    deps.hub.get(row.id) !== connection ||
    (await deps.store.hasWorkspaceLeaseFence(row.id))
  )
    return;
  try {
    await deps.workspaceLeases?.completeSetup(row.id);
    const current = await deps.store.getWorkspace(row.id);
    if (
      current?.state !== "connected" ||
      current.purgeRequestedAt ||
      current.deadlineAt <= new Date() ||
      (await deps.store.hasWorkspaceLeaseFence(row.id)) ||
      deps.hub.get(row.id) !== connection ||
      !(await setupAuthorityClosed(deps.store, current))
    )
      return;
    deps.hub.send(connection, "setup_complete_ack", { request_id: requestId });
  } catch {
    deps.log?.(`workspace ${row.id}: setup revocation pending`);
  }
}
