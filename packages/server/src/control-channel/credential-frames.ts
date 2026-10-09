import { type AgentFrame, runtimeCredentialReferences } from "@pstdio/pocketcoder-contracts";
import { activeConnectionWorkspace } from "./connection-authority";
import type { LiveConnection } from "./hub";
import { credentialDelivery } from "./workspace-credentials";
import type { WsDeps } from "./ws-types";

export async function renewCredential(
  deps: WsDeps,
  connection: LiveConnection,
  payload: Extract<AgentFrame, { type: "credential_renew" }>["payload"],
) {
  if (!deps.workspaceLeases) return;
  const row = await activeConnectionWorkspace(deps, connection);
  if (!row) return;
  const previous = await deps.store.getWorkspaceLease(payload.lease_id);
  if (
    previous?.workspaceId !== row.id ||
    previous.purpose !== "runtime-issuer" ||
    !runtimeCredentialReferences(row.templateSnapshot.spec).includes(previous.secretName)
  )
    return;
  try {
    const issued = await deps.workspaceLeases.renew(row.id, previous.id, payload.request_id);
    if (!(await activeConnectionWorkspace(deps, connection))) return;
    deps.hub.send(connection, "credential_renewed", {
      previous_lease_id: previous.id,
      request_id: payload.request_id,
      credential: credentialDelivery(issued),
    });
  } catch {
    deps.log?.(`workspace ${row.id}: credential renewal pending`);
  }
}

export async function confirmCredential(
  deps: WsDeps,
  connection: LiveConnection,
  payload: Extract<AgentFrame, { type: "credential_installed" }>["payload"],
) {
  if (!deps.workspaceLeases || !(await activeConnectionWorkspace(deps, connection))) return;
  try {
    await deps.workspaceLeases.completeRenewal(connection.workspaceId, payload.previous_lease_id, payload.lease_id);
    if (await activeConnectionWorkspace(deps, connection))
      deps.hub.send(connection, "credential_installed_ack", payload);
  } catch {
    deps.log?.(`workspace ${connection.workspaceId}: prior credential revocation pending`);
  }
}
