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
      const leases = deps.workspaceLeases;
      const connection = connectionOf(workspaceId);
      if (!leases || !connection) throw unavailable();
      const pending = (await deps.store.listPendingWorkspaceLeases(workspaceId)).filter(
        (lease) =>
          lease.managedAuthority?.sessionId === identity.sessionId &&
          lease.managedAuthority.generation === generation &&
          (lease.issuerExpiresAt ?? lease.requestExpiresAt) > new Date(),
      );
      const credentials = [];
      try {
        for (const slot of slots) {
          const own = pending.filter((lease) => lease.managedAuthority?.slot === slot);
          if (own.some((lease) => lease.state === "delivered")) continue;
          // An unfinished request is retried as itself, so failed mints never pile up against the limit.
          const unfinished = own.find((lease) => lease.state === "requested" || lease.state === "issued");
          const issued = unfinished
            ? await leases.replay(workspaceId, unfinished.id)
            : await leases.issueManaged(identity, workspaceId, generation, slot, randomUUID());
          credentials.push(credentialDelivery(issued));
        }
      } catch {
        // One session's issuer or store refusal must not stop placement of the others.
        throw unavailable();
      }
      if (credentials.length) deps.hub.send(connection, "credential_install", { credentials });
    },
    async revoke(workspaceId: string, sessionId: string) {
      await deps.workspaceLeases?.revokeSession(workspaceId, sessionId);
      const connection = connectionOf(workspaceId);
      if (connection) deps.hub.send(connection, "credential_remove", { session_id: sessionId });
    },
  };
}
