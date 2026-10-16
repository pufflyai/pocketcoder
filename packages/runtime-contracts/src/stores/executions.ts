import type {
  ConversationRequestIdentity,
  ExecutionPhase,
  ExecutionRecord,
  WorkloadAcceptance,
  WorkloadCancel,
  WorkloadExecutionReference,
} from "@pstdio/pocketcoder-contracts";

// The records stay at the process and conversation request owners.
export interface ExecutionStore {
  accept(
    input: WorkloadAcceptance,
    at: Date,
    identity?: ConversationRequestIdentity,
  ): Promise<{ kind: "accepted" | "replayed"; record: ExecutionRecord }>;
  get(execution: WorkloadExecutionReference): Promise<ExecutionRecord | null>;
  pending(): Promise<ExecutionRecord[]>;
  claim(execution: WorkloadExecutionReference, at: Date): Promise<{ first: boolean; record: ExecutionRecord } | null>;
  cancel(input: WorkloadCancel, at: Date): Promise<ExecutionRecord>;
  observe(
    execution: WorkloadExecutionReference,
    fingerprint: string,
    phase: ExecutionPhase,
    epoch: number,
    at: Date,
    outcome?: unknown,
  ): Promise<boolean>;
  acknowledge(execution: WorkloadExecutionReference, fingerprint: string, at: Date): Promise<void>;
  finalize(execution: WorkloadExecutionReference, at: Date): Promise<void>;
}
