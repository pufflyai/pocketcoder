import type {
  AgentState,
  CheckpointManifest,
  CheckpointState,
  ConversationRestoreCapability,
  ConversationRole,
  LaunchMode,
  NetworkEventInput,
  NetworkState,
  OperationKind,
  OperationState,
  PersistenceMount,
  ReasonCode,
  ResolvedSource,
  SourceDescriptor,
  StorageState,
  TemplateSnapshot,
  TemplateSpec,
  TerminalCloseReason,
  WorkspaceState,
} from "@pstdio/pocketcoder-contracts";

export const TEMPLATE_STATUSES = ["active", "available", "retired"] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

export interface TemplateRow {
  id: string;
  name: string;
  version: string;
  digest: string;
  description: string | null;
  spec: TemplateSpec;
  status: TemplateStatus;
  createdAt: Date;
  retiredAt: Date | null;
}

export interface PrincipalRow {
  id: string;
  name: string;
  scopes: string[];
  templateNames: string[];
  disabledAt: Date | null;
  createdAt: Date;
}

export interface MachineKeyRow {
  id: string;
  principalId: string;
  secretDigest: Uint8Array;
  // Empty means inherit the principal's live scopes; non-empty narrows them.
  scopes: string[];
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}

export interface WorkspaceRow {
  id: string;
  principalId: string;
  externalId: string;
  idempotencyKey: string;
  requestDigest: string;
  templateId: string;
  templateName: string;
  templateVersion: string;
  templateDigest: string;
  templateSnapshot: TemplateSnapshot;
  state: WorkspaceState;
  reasonCode: ReasonCode | null;
  agentState: AgentState;
  networkState: NetworkState;
  networkEventSeq: number;
  changeSeq: number;
  failureLogTail: string | null;
  failureLogTailTruncated: boolean;
  failureLastLogSeq: number | null;
  // Desired terminal state while `terminating` (e.g. canceled vs expired).
  terminalIntent: WorkspaceState | null;
  launchInput: Record<string, unknown> | null;
  providerKind: string | null;
  providerRef: Record<string, unknown> | null;
  provisioningMode: "cold" | "warm" | null;
  registrationDigest: Uint8Array | null;
  registrationExpiresAt: Date | null;
  reconnectDigest: Uint8Array | null;
  connectionEpoch: number;
  connectedAt: Date | null;
  disconnectedAt: Date | null;
  readyAt: Date | null;
  lastActivityAt: Date | null;
  launchAttempts: number;
  health: Record<string, string>;
  metadata: Record<string, string>;
  deadlineAt: Date;
  createdAt: Date;
  updatedAt: Date;
  terminalAt: Date | null;
  originWorkspaceId: string | null;
  restoredFromCheckpointId: string | null;
  sourceDescriptor: SourceDescriptor | null;
  resolvedSource: ResolvedSource | null;
  persistenceCapability: ConversationRestoreCapability;
  latestCheckpointId: string | null;
  launchMode: LaunchMode;
  outputs: Record<string, unknown>;
}

export interface WorkspaceStorageRow {
  id: string;
  workspaceId: string;
  principalId: string;
  providerKind: string;
  providerRef: Record<string, unknown>;
  state: StorageState;
  mountManifest: PersistenceMount[];
  logicalBytes: number | null;
  fileCount: number | null;
  retainedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  lastErrorCode: string | null;
}

export interface WorkspaceCheckpointRow {
  id: string;
  workspaceId: string;
  principalId: string;
  storageId: string;
  parentCheckpointId: string | null;
  state: CheckpointState;
  reasonCode: string | null;
  providerKind: string;
  providerRef: Record<string, unknown> | null;
  templateSnapshot: TemplateSnapshot;
  templateDigest: string;
  sourceProvenance: ResolvedSource | null;
  manifest: CheckpointManifest | null;
  manifestDigest: string | null;
  logicalBytes: number | null;
  storedBytes: number | null;
  fileCount: number | null;
  conversationRestore: ConversationRestoreCapability;
  label: string | null;
  createdAt: Date;
  updatedAt: Date;
  readyAt: Date | null;
  expiresAt: Date | null;
  deletedAt: Date | null;
}

export interface WorkspaceOperationRow {
  id: string;
  principalId: string;
  kind: OperationKind;
  state: OperationState;
  idempotencyKey: string;
  requestDigest: string;
  workspaceId: string | null;
  checkpointId: string | null;
  resultWorkspaceId: string | null;
  reasonCode: string | null;
  attemptCount: number;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export class OperationCapacityExceededError extends Error {
  constructor() {
    super("persistence operation capacity exceeded");
  }
}

export interface WorkspaceOutputRow {
  workspaceId: string;
  seq: number;
  name: string;
  value: unknown;
  occurredAt: Date;
}

export interface NetworkEventRow extends NetworkEventInput {
  workspaceId: string;
  seq: number;
  sourceSessionId: string;
}

export interface TerminalSessionRow {
  sessionId: string;
  workspaceId: string;
  keyId: string;
  openedAt: Date;
  closedAt: Date | null;
  closeReason: TerminalCloseReason | null;
  exitCode: number | null;
  bytesIn: number;
  bytesOut: number;
}

export type TerminalSessionOpen = Pick<
  TerminalSessionRow,
  "sessionId" | "workspaceId" | "keyId" | "openedAt"
>;

export interface TerminalSessionClose {
  closedAt: Date;
  closeReason: TerminalCloseReason;
  exitCode: number | null;
  bytesIn: number;
  bytesOut: number;
}

export const WARM_POOL_RUNTIME_STATES = [
  "provisioning",
  "ready",
  "leasing",
  "leased",
  "draining",
  "failed",
] as const;
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

export interface CheckpointUsage {
  count: number;
  logicalBytes: number;
}

export interface StateHistoryRow {
  id: string;
  workspaceId: string;
  fromState: WorkspaceState | null;
  toState: WorkspaceState;
  reasonCode: ReasonCode | null;
  occurredAt: Date;
}

export interface OutboxRow {
  id: string;
  workspaceId: string;
  eventType: string;
  payload: unknown;
  occurredAt: Date;
  nextAttemptAt: Date;
  attemptCount: number;
  deliveredAt: Date | null;
  lastErrorCode: string | null;
}

export interface LogRow {
  workspaceId: string;
  seq: number;
  stream: "stdout" | "stderr" | "runtime";
  occurredAt: Date;
  content: Uint8Array;
}

export interface ConversationMessageRow {
  workspaceId: string;
  seq: number;
  messageId: string;
  role: ConversationRole;
  content: string;
  occurredAt: Date;
  metadata: Record<string, string>;
  createdAt: Date;
}

export interface ConversationStateRow {
  workspaceId: string;
  status: "retained" | "deleted";
  expiresAt: Date | null;
  deletedAt: Date | null;
  updatedAt: Date;
}
