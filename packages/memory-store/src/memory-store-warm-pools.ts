import type {
  WarmPoolClaim,
  WarmPoolRuntimePatch,
  WarmPoolRuntimeRow,
  WorkspaceRow,
} from "@pstdio/pocketcoder-runtime-contracts";
import { MemoryAdmissionStore } from "./memory-store-admission";

export class MemoryWarmPoolStore extends MemoryAdmissionStore {
  async insertWarmPoolRuntime(row: WarmPoolRuntimeRow): Promise<WarmPoolRuntimeRow> {
    const existing = this.warmPoolRuntimes.get(row.id);
    if (existing) return { ...existing };
    this.warmPoolRuntimes.set(row.id, { ...row });
    return { ...row };
  }

  async getWarmPoolRuntime(id: string): Promise<WarmPoolRuntimeRow | null> {
    const row = this.warmPoolRuntimes.get(id);
    return row ? { ...row } : null;
  }

  async listWarmPoolRuntimes(): Promise<WarmPoolRuntimeRow[]> {
    return [...this.warmPoolRuntimes.values()].map((row) => ({ ...row }));
  }

  async updateWarmPoolRuntime(id: string, patch: WarmPoolRuntimePatch, at: Date): Promise<void> {
    const row = this.warmPoolRuntimes.get(id);
    if (!row) return;
    Object.assign(row, patch);
    row.updatedAt = at;
  }

  async claimWarmPoolRuntime(
    claim: WarmPoolClaim,
  ): Promise<{ runtime: WarmPoolRuntimeRow; workspace: WorkspaceRow } | null> {
    const workspace = this.workspaces.get(claim.workspaceId);
    if (workspace?.state !== "queued") return null;
    const runtime = [...this.warmPoolRuntimes.values()]
      .filter(
        (row) =>
          row.state === "ready" &&
          row.templateDigest === claim.templateDigest &&
          row.driverKind === claim.driverKind &&
          row.eligibilityFingerprint === claim.eligibilityFingerprint,
      )
      .sort((a, b) => (a.readyAt?.getTime() ?? 0) - (b.readyAt?.getTime() ?? 0))[0];
    if (!runtime?.providerRef) return null;
    runtime.state = "leasing";
    runtime.workspaceId = workspace.id;
    runtime.leasedAt = claim.at;
    runtime.updatedAt = claim.at;
    workspace.state = "provisioning";
    workspace.provisioningMode = "warm";
    workspace.providerKind = runtime.driverKind;
    workspace.providerRef = runtime.providerRef;
    workspace.registrationDigest = claim.registrationDigest;
    workspace.registrationExpiresAt = claim.registrationExpiresAt;
    workspace.launchAttempts += 1;
    workspace.changeSeq += 1;
    workspace.updatedAt = claim.at;
    this.appendHistory(workspace, "queued", "provisioning", null, claim.at);
    this.appendWorkspaceEvent(workspace, claim.at);
    this.notifyWorkspaceChange(workspace.id);
    return { runtime: { ...runtime }, workspace: { ...workspace } };
  }

  // --- Principals and keys ---
}
