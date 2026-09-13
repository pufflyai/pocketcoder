import type { WorkspaceRow } from "./workspaces";

export const WARM_POOL_RUNTIME_STATES = ["provisioning", "ready", "leasing", "leased", "draining", "failed"] as const;

export type WarmPoolRuntimeState = (typeof WARM_POOL_RUNTIME_STATES)[number];

export interface WarmPoolRuntimeRow {
  id: string;
  templateId: string;
  templateName: string;
  templateVersion: string;
  templateDigest: string;
  driverKind: string;
  eligibilityFingerprint: string;
  state: WarmPoolRuntimeState;
  providerRef: Record<string, unknown> | null;
  enrollmentDigest: Uint8Array | null;
  enrollmentExpiresAt: Date | null;
  workspaceId: string | null;
  createdAt: Date;
  updatedAt: Date;
  readyAt: Date | null;
  leasedAt: Date | null;
  failureCode: string | null;
}

export type WarmPoolRuntimePatch = Partial<
  Pick<
    WarmPoolRuntimeRow,
    | "state"
    | "providerRef"
    | "enrollmentDigest"
    | "enrollmentExpiresAt"
    | "workspaceId"
    | "readyAt"
    | "leasedAt"
    | "failureCode"
  >
>;

export interface WarmPoolClaim {
  workspaceId: string;
  templateDigest: string;
  driverKind: string;
  eligibilityFingerprint: string;
  registrationDigest: Uint8Array;
  registrationExpiresAt: Date;
  at: Date;
}

export interface WarmPoolStore {
  insertWarmPoolRuntime(row: WarmPoolRuntimeRow): Promise<WarmPoolRuntimeRow>;
  getWarmPoolRuntime(id: string): Promise<WarmPoolRuntimeRow | null>;
  listWarmPoolRuntimes(): Promise<WarmPoolRuntimeRow[]>;
  updateWarmPoolRuntime(id: string, patch: WarmPoolRuntimePatch, at: Date): Promise<void>;
  claimWarmPoolRuntime(claim: WarmPoolClaim): Promise<{ runtime: WarmPoolRuntimeRow; workspace: WorkspaceRow } | null>;
}
