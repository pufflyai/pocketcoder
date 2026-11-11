import { randomUUID } from "node:crypto";
import {
  ApiError,
  SESSION_CREDENTIAL_MIN_PROTOCOL_VERSION,
  templateCredentialReferences,
} from "@pstdio/pocketcoder-contracts";
import type { ManagedSessionIdentity } from "@pstdio/pocketcoder-runtime-core";
import { credentialDelivery } from "./workspace-credentials";
import type { WsDeps } from "./ws-types";

const unavailable = () => new ApiError("secret.unavailable", "Session credentials are unavailable.");

// Owned by the placement owner: issue a bound session's missing leases and install them on its
// workspace, and revoke them alone when the session leaves shared compute.
export function sessionCredentials(deps: Pick<WsDeps, "store" | "hub" | "workspaceLeases">) {
  const connectionOf = (workspaceId: string) => {
    const connection = deps.hub.get(workspaceId);
    return connection?.registered && connection.protocolVersion >= SESSION_CREDENTIAL_MIN_PROTOCOL_VERSION
      ? connection
      : null;
  };
  return {
    async deliver(identity: ManagedSessionIdentity, workspaceId: string, generation: number) {
      const row = await deps.store.getWorkspace(workspaceId);
      const slots = row ? templateCredentialReferences(row.templateSnapshot) : [];
      if (!slots.length) return;
      const connection = connectionOf(workspaceId);
      if (!deps.workspaceLeases || !connection) throw unavailable();
      const held = (await deps.store.listPendingWorkspaceLeases(workspaceId)).filter(
        (lease) =>
          lease.state === "delivered" &&
          lease.managedAuthority?.sessionId === identity.sessionId &&
          lease.managedAuthority.generation === generation &&
          (lease.issuerExpiresAt ?? lease.requestExpiresAt) > new Date(),
      );
      const missing = slots.filter((slot) => !held.some((lease) => lease.managedAuthority?.slot === slot));
      if (!missing.length) return;
      const credentials = [];
      for (const slot of missing)
        credentials.push(
          credentialDelivery(
            await deps.workspaceLeases.issueManaged(identity, workspaceId, generation, slot, randomUUID()),
          ),
        );
      deps.hub.send(connection, "credential_install", { credentials });
    },
    async revoke(workspaceId: string, sessionId: string) {
      await deps.workspaceLeases?.revokeSession(workspaceId, sessionId);
      const connection = connectionOf(workspaceId);
      if (connection) deps.hub.send(connection, "credential_remove", { session_id: sessionId });
    },
  };
}
