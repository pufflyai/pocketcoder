import { type AgentFrame, runtimeCredentialReferences } from "@pstdio/pocketcoder-contracts";
import { issuerBackoff } from "../secrets/issuer-backoff";
import { activeConnectionWorkspace } from "./connection-authority";
import type { LiveConnection } from "./hub";
import { credentialDelivery } from "./workspace-credentials";
import type { WsDeps } from "./ws-types";

const renewals = new WeakMap<LiveConnection, ReturnType<typeof issuerBackoff>>();

export async function renewCredential(
  deps: WsDeps,
  connection: LiveConnection,
  payload: Extract<AgentFrame, { type: "credential_renew" }>["payload"],
) {
  if (!deps.workspaceLeases) return;
  const row = await activeConnectionWorkspace(deps, connection);
  if (!row) return;
  const previous = await deps.store.getWorkspaceLease(payload.lease_id);
  // A session lease renews under its recorded authority; a workspace lease by its template reference.
  if (
    previous?.workspaceId !== row.id ||
    previous.purpose !== "runtime-issuer" ||
    (!previous.managedAuthority &&
      !runtimeCredentialReferences(row.templateSnapshot.spec).includes(previous.secretName))
  )
    return;
  try {
    let retry = renewals.get(connection);
    if (!retry) {
      retry = issuerBackoff();
      renewals.set(connection, retry);
    }
    const issued = await retry.run(previous.id, () =>
      deps.workspaceLeases!.renew(row.id, previous.id, payload.request_id),
    );
    if (!(await activeConnectionWorkspace(deps, connection))) return;
    await deps.assertAccountAllowed?.();
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
    await deps.assertAccountAllowed?.();
    if (await activeConnectionWorkspace(deps, connection))
      deps.hub.send(connection, "credential_installed_ack", payload);
  } catch {
    deps.log?.(`workspace ${connection.workspaceId}: prior credential revocation pending`);
  }
}

export function acknowledgeInstall(
  connection: LiveConnection,
  payload: Extract<AgentFrame, { type: "credential_install_ack" }>["payload"],
) {
  connection.installedLeases ??= new Set();
  for (const id of payload.lease_ids) connection.installedLeases.add(id);
}
