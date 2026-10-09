import { randomUUID } from "node:crypto";
import { ApiError, digestOf } from "@pstdio/pocketcoder-contracts";
import type { WorkspaceLeasePurpose, WorkspaceLeaseStore } from "@pstdio/pocketcoder-runtime-core";
import type { createIssuerClient } from "./issuer-client";
import type { createSecretVault } from "./secret-vault";

export function createWorkspaceLeaseService({
  store,
  vault,
  issuer,
  now = () => new Date(),
}: {
  store: WorkspaceLeaseStore;
  vault: ReturnType<typeof createSecretVault>;
  issuer: ReturnType<typeof createIssuerClient>;
  now?: () => Date;
}) {
  const unavailable = () => new ApiError("secret.unavailable", "Workspace issuer is unavailable.");
  async function deliver(
    config: Awaited<ReturnType<typeof vault.resolve>>,
    row: Awaited<ReturnType<typeof store.requestWorkspaceLease>>,
  ) {
    if (config.type === "registry" || ["revoking", "revoked", "expired"].includes(row.state)) throw unavailable();
    const result = await issuer.mint(config.value, row);
    const issued = await store.recordWorkspaceLeaseIssued(
      row.id,
      result.leaseId,
      result.expiresAt,
      Buffer.byteLength(result.credential),
      now(),
    );
    const delivered = issued?.state !== "revoking" && (await store.recordWorkspaceLeaseDelivered(row.id, now()));
    if (!delivered) {
      await revoke(row.id);
      throw unavailable();
    }
    return { lease: delivered, credential: result.credential };
  }
  async function revoke(id: string) {
    const row = await store.requestWorkspaceLeaseRevocation(id, now());
    if (row.state === "revoked" || row.state === "expired") return;
    if (await store.recordWorkspaceLeaseExpired(id, now())) return;
    const config = await vault.resolveVersion(row.secretVersionId, row.purpose);
    if (config.type === "registry") throw unavailable();
    await issuer.revoke(config.value, row);
    await store.recordWorkspaceLeaseRevoked(id, row.requestId, now());
  }
  async function issue(
    workspaceId: string,
    name: string,
    purpose: WorkspaceLeasePurpose,
    requestId: string = randomUUID(),
  ) {
    const config = await vault.resolve(name, purpose);
    if (config.type === "registry") throw unavailable();
    const row = await store.requestWorkspaceLease({
      workspaceId,
      secretName: name,
      secretVersionId: config.id,
      purpose,
      policyDigest: digestOf(config.value.policy),
      requestId,
      at: now(),
    });
    return await deliver(config, row);
  }
  return {
    issue,
    async replay(workspaceId: string, leaseId: string) {
      const row = await store.getWorkspaceLease(leaseId);
      if (!row || row.workspaceId !== workspaceId) throw unavailable();
      const config = await vault.resolveVersion(row.secretVersionId, row.purpose);
      return await deliver(config, row);
    },
    revoke,
    async completeSetup(workspaceId: string) {
      const pending = await store.listPendingWorkspaceLeases(workspaceId);
      for (const row of pending) {
        if (row.purpose === "setup-issuer") await revoke(row.id);
      }
    },
    async revokeWorkspace(workspaceId: string) {
      await store.fenceWorkspaceLeases(workspaceId, now());
      const pending = await store.listPendingWorkspaceLeases(workspaceId);
      let failed = false;
      for (const row of pending) {
        try {
          await revoke(row.id);
        } catch {
          failed = true;
        }
      }
      if (failed) throw unavailable();
    },
  };
}
