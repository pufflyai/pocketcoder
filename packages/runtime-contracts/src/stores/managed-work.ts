import type { InputObjectReference, managed } from "@pstdio/pocketcoder-contracts";
import type { ManagedSessionIdentity } from "./managed-sessions";

// One durable stop command. Its identity and deadline never change after acceptance.
export interface ManagedCancelRecord {
  cancelId: string;
  scope: "request" | "session";
  acceptedAt: string;
  cancelDeadline: string;
  completedAt: string | null;
}
// The workspace the placement owner created for a session before it could bind it.
export interface ManagedPlacementIntent {
  workspaceId: string;
  generation: number;
  requestedAt: string;
}
// Stored on the existing canonical conversation request, including after content retention ends.
export interface ManagedRequestRecord {
  keyId: string;
  input: managed.RequestInput | null;
  contentRemoved?: boolean;
  physicalExecution?: import("@pstdio/pocketcoder-contracts").WorkloadExecutionReference;
  attempts?: {
    execution: import("@pstdio/pocketcoder-contracts").WorkloadExecutionReference;
    fingerprint: string;
    bindingRevision: number | null;
    neverStartedAt: string;
  }[];
  cancel?: ManagedCancelRecord;
  request: managed.Request;
  sequence: number;
  queueBytes: number;
  queueReleased: boolean;
  bindingRevision: number | null;
}
export interface ManagedQueueLimits {
  count: number;
  bytes: number;
}
// A stop command reports the execution records that now need a targeted producer cancel.
export interface ManagedStopResult {
  receipt: managed.CancelReceipt;
  executions: import("@pstdio/pocketcoder-contracts").ExecutionRecord[];
}
export interface ManagedRequestStore {
  completeCleanup(workspaceId: string): Promise<void>;
  accept(
    keyId: string,
    sessionId: string,
    input: managed.RequestInput,
    limits: ManagedQueueLimits,
  ): Promise<{ replayed: boolean; request: managed.Request }>;
  get(keyId: string, sessionId: string, requestId: string): Promise<managed.Request>;
  cancel(
    keyId: string,
    sessionId: string,
    requestId: string,
    command: managed.CancelCommand,
    windowMs: number,
    at: Date,
  ): Promise<ManagedStopResult>;
  prepare(at: Date): Promise<void>;
}
export interface ManagedFileStore {
  register(
    keyId: string,
    sessionId: string,
    input: managed.InputUpload,
    limits: { fileBytes: number; stagedBytes: number; files: number; transfers: number; retentionMs: number },
  ): Promise<managed.InputObject>;
  get(keyId: string, sessionId: string, inputId: string): Promise<managed.InputObject>;
  upload(
    keyId: string,
    sessionId: string,
    inputId: string,
  ): Promise<{ principalId: string; reference: InputObjectReference; sessionId: string; expiresAt: Date }>;
  exports(keyId: string, sessionId: string, requestId?: string): Promise<managed.ExportObject[]>;
  content(keyId: string, sessionId: string, exportId: string): Promise<Uint8Array>;
}
export interface ManagedCapacityIdentity extends ManagedSessionIdentity {
  workspaceId: string;
  generation: number;
}
export interface ManagedCapacityRecord {
  principalId: string;
  profileId: string;
  profileRevision: number;
  scopeIds: string[];
  placementKey: string;
  sessions: { sessionId: string; generation: number; stoppedAt: string | null }[];
  state: "reserved" | "launch_claimed" | "active" | "cleanup_pending" | "released";
  starts: { attempt: number; claimedAt: string; submitted: boolean }[];
  cleanup: managed.CleanupReceipt | null;
  admittedAttempt?: number;
}
export interface ManagedCapacityStore {
  // A live workspace a shared session may join, or null when it needs new compute.
  joinable(identity: ManagedSessionIdentity): Promise<string | null>;
  releaseUnlaunched(workspaceId: string, at: Date): Promise<void>;
  reconcile(at: Date): Promise<void>;
  place(identity: ManagedCapacityIdentity): Promise<void>;
  managed(workspaceId: string): Promise<boolean>;
  claimLaunch(workspaceId: string, attempt: number, at: Date): Promise<void>;
  notSubmitted(workspaceId: string, attempt: number, at: Date): Promise<void>;
  cleanupPending(workspaceId: string, attempt: number, at: Date): Promise<void>;
  cleanup(
    workspaceId: string,
    attempt: number,
    basis: "never_launched" | "provider_fenced",
    at: Date,
  ): Promise<managed.CleanupReceipt | null>;
  processStopped(identity: ManagedCapacityIdentity, incarnationId: string, at: Date): Promise<void>;
}
