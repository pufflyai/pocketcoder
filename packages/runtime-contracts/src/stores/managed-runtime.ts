import type { managed } from "@pstdio/pocketcoder-contracts";
import type { ManagedInvocationIdentity, ManagedReservation, ManagedUsageEvidence } from "./managed-budgets";
import type { ManagedSessionIdentity } from "./managed-sessions";

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
  touchedUntil: Date;
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
  reconcile(keyId: string, input: ManagedUsageEvidence, reason: string): Promise<void>;
  usage(keyId: string, scopeId: string): Promise<managed.BudgetUsage>;
}
export interface ManagedRuntimeStore {
  authority: ManagedAuthorityStore;
  sessions: ManagedSessionStore;
  budgets: ManagedBudgetStore;
}
