import type { managed } from "@pstdio/pocketcoder-contracts";
import type { ManagedInvocationIdentity, ManagedReservation, ManagedUsageEvidence } from "./managed-budgets";
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
export interface InvocationInput {
  requestDigest: string;
  countEvidenceRef: string;
  identity: ManagedInvocationIdentity;
  workspaceId: string;
  model: string;
  inputTokens: number;
  requestedOutputTokens: number | null;
}
export interface InvocationRecord {
  reservation: ManagedReservation;
  workspaceId: string;
  fingerprint: string;
  bindingRevision: number;
  generation: number;
  incarnationId: string;
  policyRevisions: Record<string, number>;
  state: "reserved" | "send_claimed" | "uncertain" | "settled" | "conflict" | "abandoned";
  settledInput: number;
  settledOutput: number;
  evidence: ManagedUsageEvidence | null;
  evidenceDigest: string | null;
  // The provider response identity, persisted as soon as the gateway observes it.
  responseId?: string;
  touchedUntil: Date;
}
export interface OpenInvocation {
  identity: ManagedInvocationIdentity;
  state: "reserved" | "send_claimed";
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
}
export interface ManagedBudgetStore {
  writePolicy(
    keyId: string,
    input: managed.BudgetPolicyWrite,
    expectedRevision: number | null,
  ): Promise<managed.BudgetPolicy>;
  readPolicy(keyId: string, scopeId: string): Promise<managed.BudgetPolicy>;
  reserve(input: InvocationInput): Promise<{ replayed: boolean; reservation: ManagedReservation }>;
  claimSend(identity: ManagedInvocationIdentity): Promise<boolean>;
  abandonUnsent(identity: ManagedInvocationIdentity): Promise<void>;
  settle(input: ManagedUsageEvidence): Promise<void>;
  retainUncertain(identity: ManagedInvocationIdentity): Promise<void>;
  // Invocations that a stopped gateway left without a send decision or without usage.
  openInvocations(): Promise<OpenInvocation[]>;
  observeResponse(identity: ManagedInvocationIdentity, responseId: string): Promise<void>;
  reconcile(keyId: string, input: ManagedUsageEvidence, reason: string): Promise<void>;
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
export interface ManagedGatewayGrant {
  identity: ManagedSessionIdentity & { requestId: string };
  workspaceId: string;
  incarnationId: string;
  generation: number;
  allowedModels: string[];
}
export interface ManagedGatewayGrantStore {
  issue(workspaceId: string, incarnationId: string, at: Date): Promise<{ token: string; expiresAt: Date }>;
  resolve(token: string, turnId: string | null, at: Date): Promise<ManagedGatewayGrant>;
}
export interface ManagedHistoryStore {
  history(keyId: string, sessionId: string, cursor: string | null, limit: number): Promise<managed.HistoryPage>;
  events(keyId: string, sessionId: string, after: string | null, limit: number): Promise<managed.RuntimeEvent[]>;
  prune(keepEvents: number): Promise<number>;
}
export interface ManagedRuntimeStore {
  history: ManagedHistoryStore;
  recovery: ManagedRecoveryStore;
  grants: ManagedGatewayGrantStore;
  authority: ManagedAuthorityStore;
  sessions: ManagedSessionStore;
  budgets: ManagedBudgetStore;
  requests: ManagedRequestStore;
  files: ManagedFileStore;
  capacity: ManagedCapacityStore;
}
