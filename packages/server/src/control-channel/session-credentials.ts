import { randomUUID } from "node:crypto";
import {
  ApiError,
  SESSION_CREDENTIAL_MIN_PROTOCOL_VERSION,
  templateCredentialReferences,
} from "@pstdio/pocketcoder-contracts";
import type { ManagedSessionIdentity, WorkspaceLeaseRow } from "@pstdio/pocketcoder-runtime-core";
import { credentialDelivery, latestSessionLeases } from "./workspace-credentials";
import type { WsDeps } from "./ws-types";

const unavailable = () => new ApiError("secret.unavailable", "Session credentials are unavailable.");
const live = (lease: WorkspaceLeaseRow) => (lease.issuerExpiresAt ?? lease.requestExpiresAt) > new Date();

// The supervisor's limits for everything a workspace holds; a reconnect replays all sessions at once.
export const SESSION_CREDENTIAL_LIMITS = { count: 64, bytes: 524_288 };

// Owned by the placement owner: issue a bound session's leases, install them on its workspace and
// report whether the supervisor confirmed them, and revoke them alone when the session leaves.
export function sessionCredentials(
  deps: Pick<WsDeps, "store" | "hub" | "workspaceLeases">,
  limits = SESSION_CREDENTIAL_LIMITS,
) {
  const connectionOf = (workspaceId: string) => {
    const connection = deps.hub.get(workspaceId);
    return connection?.registered && connection.protocolVersion >= SESSION_CREDENTIAL_MIN_PROTOCOL_VERSION
      ? connection
      : null;
  };
  return {
    // True once the supervisor confirmed a live lease for every slot. Until then every slot is sent
    // again, so a lease issued before a later slot failed is never left out.
    async deliver(identity: ManagedSessionIdentity, workspaceId: string, generation: number) {
      const row = await deps.store.getWorkspace(workspaceId);
      const slots = row ? templateCredentialReferences(row.templateSnapshot) : [];
      if (!slots.length) return true;
      const leases = deps.workspaceLeases;
      const connection = connectionOf(workspaceId);
      if (!leases || !connection) throw unavailable();
      const pending = (await deps.store.listPendingWorkspaceLeases(workspaceId)).filter(live);
      const own = latestSessionLeases(
        pending.filter(
          (lease) =>
            lease.managedAuthority?.sessionId === identity.sessionId &&
            lease.managedAuthority.generation === generation,
        ),
      );
      const current = slots.map((slot) => own.find((lease) => lease.managedAuthority?.slot === slot));
      if (current.every((lease) => lease?.state === "delivered" && connection.installedLeases?.has(lease.id)))
        return true;
      const credentials = [];
      try {
        for (const [index, slot] of slots.entries()) {
          const known = current[index];
          // A known request is replayed as itself, so failed mints never pile up against the limit.
          const issued = known
            ? await leases.replay(workspaceId, known.id)
            : await leases.issueManaged(identity, workspaceId, generation, slot, randomUUID());
          credentials.push(credentialDelivery(issued));
        }
      } catch {
        // One session's issuer or store refusal must not stop placement of the others.
        throw unavailable();
      }
      const siblings = latestSessionLeases(
        pending.filter((lease) => lease.managedAuthority && lease.managedAuthority.sessionId !== identity.sessionId),
      );
      const bytes =
        siblings.reduce((sum, lease) => sum + (lease.credentialBytes ?? 0), 0) +
        credentials.reduce((sum, value) => sum + Buffer.byteLength(value.credential), 0);
      if (siblings.length + credentials.length > limits.count || bytes > limits.bytes) throw unavailable();
      deps.hub.send(connection, "credential_install", { credentials });
      return false;
    },
    async revoke(workspaceId: string, sessionId: string) {
      await deps.workspaceLeases?.revokeSession(workspaceId, sessionId);
      const connection = connectionOf(workspaceId);
      if (connection) deps.hub.send(connection, "credential_remove", { session_id: sessionId });
    },
  };
}
