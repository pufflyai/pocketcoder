import type { SecretType } from "@pstdio/pocketcoder-contracts";

export const WORKSPACE_LEASE_STATES = [
  "requested",
  "issued",
  "delivered",
  "revoking",
  "revoked",
  "expired",
  "superseded",
] as const;
export type WorkspaceLeasePurpose = Exclude<SecretType, "registry">;
export interface WorkspaceLeaseRequest {
  workspaceId: string;
  secretName: string;
  secretVersionId: string | null;
  purpose: WorkspaceLeasePurpose;
  policyDigest: string;
  requestId: string;
  managedAuthority?: import("./managed-runtime").ManagedLeaseAuthority;
  at: Date;
}
export interface WorkspaceLeaseRow {
  managedAuthority: import("./managed-runtime").ManagedLeaseAuthority | null;
  id: string;
  workspaceId: string;
  secretName: string;
  secretVersionId: string | null;
  purpose: WorkspaceLeasePurpose;
  sourceUrl: string | null;
  sourceRevision: string | null;
  templateDigest: string;
  policyDigest: string;
  requestId: string;
  requestDigest: string;
  requestExpiresAt: Date;
  removedAt: Date | null;
  revokeAcknowledgedAt: Date | null;
  issuerExpiresAt: Date | null;
  credentialBytes: number | null;
  state: (typeof WORKSPACE_LEASE_STATES)[number];
  createdAt: Date;
  updatedAt: Date;
  deliveredAt: Date | null;
  closedAt: Date | null;
}
export interface WorkspaceLeaseStore {
  requestWorkspaceLease(input: WorkspaceLeaseRequest): Promise<WorkspaceLeaseRow>;
  supersedeWorkspaceLease(id: string, at: Date): Promise<void>;
  acknowledgeSessionLeaseRemoval(workspaceId: string, sessionId: string, at: Date): Promise<void>;
  acknowledgeLeaseRevocation(id: string, at: Date): Promise<void>;
  getWorkspaceLease(id: string): Promise<WorkspaceLeaseRow | null>;
  listWorkspaceLeases(workspaceId: string): Promise<WorkspaceLeaseRow[]>;
  listPendingWorkspaceLeases(workspaceId?: string): Promise<WorkspaceLeaseRow[]>;
  recordWorkspaceLeaseIssued(
    id: string,
    expiresAt: Date,
    credentialBytes: number,
    at: Date,
  ): Promise<WorkspaceLeaseRow | null>;
  recordWorkspaceLeaseDelivered(id: string, at: Date): Promise<WorkspaceLeaseRow | null>;
  requestWorkspaceLeaseRevocation(id: string, at: Date): Promise<WorkspaceLeaseRow>;
  fenceWorkspaceLeases(workspaceId: string, at: Date): Promise<void>;
  hasWorkspaceLeaseFence(workspaceId: string): Promise<boolean>;
  recordWorkspaceLeaseRevoked(id: string, requestId: string, at: Date): Promise<WorkspaceLeaseRow | null>;
  recordWorkspaceLeaseExpired(id: string, at: Date): Promise<WorkspaceLeaseRow | null>;
}
