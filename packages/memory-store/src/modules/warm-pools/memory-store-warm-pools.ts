import type {
  WarmPoolClaim,
  WarmPoolRuntimePatch,
  WarmPoolRuntimeRow,
  WorkspaceRow,
} from "@pstdio/pocketcoder-runtime-contracts";

import type { MemoryState } from "../../state/memory-store-base";

export class MemoryWarmPoolStore {
  constructor(
    private readonly context: Pick<
      MemoryState,
      "warmPoolRuntimes" | "workspaces" | "appendHistory" | "appendWorkspaceEvent" | "notifyWorkspaceChange"
    >,
  ) {}
  async insertWarmPoolRuntime(row: WarmPoolRuntimeRow): Promise<WarmPoolRuntimeRow> {
    const existing = this.context.warmPoolRuntimes.get(row.id);
    if (existing) return { ...existing };
    this.context.warmPoolRuntimes.set(row.id, { ...row });
    return { ...row };
  }

  async getWarmPoolRuntime(id: string): Promise<WarmPoolRuntimeRow | null> {
    const row = this.context.warmPoolRuntimes.get(id);
    return row ? { ...row } : null;
  }

  async listWarmPoolRuntimes(): Promise<WarmPoolRuntimeRow[]> {
    return [...this.context.warmPoolRuntimes.values()].map((row) => ({ ...row }));
  }

  async updateWarmPoolRuntime(id: string, patch: WarmPoolRuntimePatch, at: Date): Promise<void> {
    const row = this.context.warmPoolRuntimes.get(id);
    if (!row) return;
    Object.assign(row, patch);
    row.updatedAt = at;
  }

  async claimWarmPoolRuntime(
    claim: WarmPoolClaim,
  ): Promise<{ runtime: WarmPoolRuntimeRow; workspace: WorkspaceRow } | null> {
    const workspace = this.context.workspaces.get(claim.workspaceId);
    if (workspace?.state !== "queued" || workspace.purgeRequestedAt) return null;
    const runtime = [...this.context.warmPoolRuntimes.values()]
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
    this.context.appendHistory(workspace, "queued", "provisioning", null, claim.at);
    this.context.appendWorkspaceEvent(workspace, claim.at);
    this.context.notifyWorkspaceChange(workspace.id);
    return { runtime: { ...runtime }, workspace: { ...workspace } };
  }
}
