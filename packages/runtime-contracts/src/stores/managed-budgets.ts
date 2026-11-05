import type { managed } from "@pstdio/pocketcoder-contracts";
import type { ManagedRequestIdentity } from "./managed-sessions";

export interface ManagedInvocationIdentity extends ManagedRequestIdentity {
  invocationId: string;
}
export interface ManagedReservation {
  identity: ManagedInvocationIdentity;
  profileId: string;
  profileRevision: number;
  scopeIds: string[];
  model: string;
  inputTokens: number;
  outputTokenCap: number;
  reservedAt: Date;
}
export interface ManagedUsageEvidence {
  identity: ManagedInvocationIdentity;
  inputTokens: number;
  outputTokens: number;
  providerEvidenceRef: string;
  observedAt: Date;
}

// PC-167–176 implement these ports. Model settlement and physical cleanup are
// independent evidence; neither port may infer the other from elapsed time.
export interface ManagedBudgetPorts<Tx> {
  transaction<T>(run: (tx: Tx) => Promise<T>): Promise<T>;
  writePolicy(
    tx: Tx,
    principalId: string,
    input: managed.BudgetPolicyWrite,
    expectedRevision: number | null,
  ): Promise<managed.BudgetPolicy>;
  reserve(tx: Tx, reservation: ManagedReservation): Promise<{ replayed: boolean }>;
  settle(tx: Tx, evidence: ManagedUsageEvidence): Promise<void>;
  retainUncertain(tx: Tx, identity: ManagedInvocationIdentity): Promise<void>;
  cleanup(tx: Tx, receipt: managed.CleanupReceipt): Promise<void>;
  usage(principalId: string, scopeId: string): Promise<managed.BudgetUsage>;
}
