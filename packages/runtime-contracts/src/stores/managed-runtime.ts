import type { managed } from "@pstdio/pocketcoder-contracts";
import type { ManagedSessionIdentity } from "./managed-sessions";
import type { ManagedCapacityStore, ManagedFileStore, ManagedRequestStore, ManagedStopResult } from "./managed-work";

export type {
  ManagedCancelRecord,
  ManagedCapacityIdentity,
  ManagedCapacityRecord,
  ManagedCapacityStore,
  ManagedFileStore,
  ManagedPlacementIntent,
  ManagedQueueLimits,
  ManagedRequestRecord,
  ManagedRequestStore,
  ManagedStopResult,
} from "./managed-work";

export interface ManagedBinding {
  workspaceId: string;
  incarnationId: string;
  generation: number;
}
export interface ManagedCredentialBinding {
  bindingId: string;
  principalId: string;
  secretName: string;
  secretVersionId: string;
  slots: string[];
  authorityExpiresAt: Date;
}
export interface ManagedLeaseAuthority extends ManagedSessionIdentity {
  profileId: string;
  profileRevision: number;
  generation: number;
  incarnationId: string;
  bindingId: string;
  slot: string;
  authorityExpiresAt: string;
}
export interface ManagedAuthorityStore {
  registerScope(keyId: string, scopeId: string, principalId: string, installation?: boolean): Promise<void>;
  provisionProfile(
    keyId: string,
    principalId: string,
    input: managed.ExecutionProfile,
  ): Promise<managed.ExecutionProfile>;
  profile(keyId: string, profileId: string, revision: number): Promise<managed.ExecutionProfile>;
  registerCredential(
    keyId: string,
    binding: Omit<ManagedCredentialBinding, "secretVersionId"> & { secretVersionId?: string },
  ): Promise<void>;
  leaseAuthority(
    identity: ManagedSessionIdentity,
    workspaceId: string,
    generation: number,
    slot: string,
  ): Promise<{ authority: ManagedLeaseAuthority; secretName: string; secretVersionId: string }>;
}
export interface ManagedSessionStore {
  create(keyId: string, input: managed.SessionCreate): Promise<managed.Session>;
  get(keyId: string, sessionId: string): Promise<managed.Session>;
  bind(identity: ManagedSessionIdentity, expectedRevision: number, binding: ManagedBinding | null): Promise<number>;
  appendObservation(
    identity: ManagedSessionIdentity,
    expectedRevision: number,
    state: managed.Session["state"],
    reasonCode: string | null,
  ): Promise<managed.Session>;
  close(
    keyId: string,
    sessionId: string,
    command: managed.CancelCommand,
    windowMs: number,
    at: Date,
  ): Promise<ManagedStopResult>;
  // The current physical binding behind a logical session, after the caller's read authority is rechecked.
  binding(keyId: string, sessionId: string): Promise<(ManagedBinding & { bindingRevision: number }) | null>;
}
export interface ManagedBudgetStore {
  writePolicy(
    keyId: string,
    input: managed.BudgetPolicyWrite,
    expectedRevision: number | null,
  ): Promise<managed.BudgetPolicy>;
  readPolicy(keyId: string, scopeId: string): Promise<managed.BudgetPolicy>;
  usage(keyId: string, scopeId: string): Promise<managed.BudgetUsage>;
}
export interface ManagedRecoveryCandidate {
  id: ManagedSessionIdentity;
  session: managed.Session;
  binding: ManagedBinding | null;
  bindingRevision: number;
  lastGeneration: number;
  queueCount: number;
  placement: import("./managed-work").ManagedPlacementIntent | null;
  resumeRequested: boolean;
  templateDigest: string;
  closing: boolean;
  // Compute a closing session owns alone and must stop.
  ownedWorkspaceIds: string[];
  openRequests: number;
}
export interface ManagedRecoveryStore {
  candidates(): Promise<ManagedRecoveryCandidate[]>;
  resume(keyId: string, sessionId: string, at: Date): Promise<managed.Session>;
  recordPlacement(
    identity: ManagedSessionIdentity,
    intent: import("./managed-work").ManagedPlacementIntent,
  ): Promise<import("./managed-work").ManagedPlacementIntent>;
  failPlacement(identity: ManagedSessionIdentity, workspaceId: string): Promise<void>;
  placed(identity: ManagedSessionIdentity, workspaceId: string): Promise<void>;
  transition(
    identity: ManagedSessionIdentity,
    state: managed.Session["state"],
    reasonCode: string | null,
  ): Promise<managed.Session>;
}
export interface ManagedHistoryStore {
  history(keyId: string, sessionId: string, cursor: string | null, limit: number): Promise<managed.HistoryPage>;
  events(keyId: string, sessionId: string, after: string | null, limit: number): Promise<managed.RuntimeEvent[]>;
  prune(keepEvents: number): Promise<number>;
}
export interface ManagedRuntimeStore {
  history: ManagedHistoryStore;
  recovery: ManagedRecoveryStore;
  authority: ManagedAuthorityStore;
  sessions: ManagedSessionStore;
  budgets: ManagedBudgetStore;
  requests: ManagedRequestStore;
  files: ManagedFileStore;
  capacity: ManagedCapacityStore;
}
