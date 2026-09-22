import type {
  AgentState,
  ConversationRestoreCapability,
  LaunchMode,
  NetworkState,
  ReasonCode,
  ResolvedSource,
  SourceDescriptor,
  TemplateSnapshot,
  WorkspaceState,
} from "@pstdio/pocketcoder-contracts";

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
  purgeRequestedAt: Date | null;
  originWorkspaceId: string | null;
  restoredFromCheckpointId: string | null;
  sourceDescriptor: SourceDescriptor | null;
  resolvedSource: ResolvedSource | null;
  persistenceCapability: ConversationRestoreCapability;
  latestCheckpointId: string | null;
  launchMode: LaunchMode;
  outputs: Record<string, unknown>;
}

export interface StateHistoryRow {
  id: string;
  workspaceId: string;
  fromState: WorkspaceState | null;
  toState: WorkspaceState;
  reasonCode: ReasonCode | null;
  occurredAt: Date;
}

export interface WorkspaceListFilter {
  externalId?: string;
  state?: WorkspaceState;
  template?: string;
  metadata?: Record<string, string>;
  createdAfter?: Date;
  createdBefore?: Date;
  limit: number;
  cursor?: string;
}

export interface ActiveCounts {
  global: number;
  byPrincipal: Record<string, number>;
  byTemplate: Record<string, number>;
}

export interface WorkspaceAdmissionClaim {
  workspaceId: string;
  at: Date;
  registrationDigest: Uint8Array;
  registrationExpiresAt: Date;
  limits: {
    globalActiveWorkspaces: number;
    perPrincipalActiveWorkspaces: number;
    perTemplateActiveWorkspaces: Record<string, number>;
  };
}

export interface WorkspaceInsert {
  id: string;
  principalId: string;
  externalId: string;
  idempotencyKey: string;
  requestDigest: string;
  templateId: string;
  templateSnapshot: TemplateSnapshot;
  launchInput: Record<string, unknown> | null;
  metadata: Record<string, string>;
  deadlineAt: Date;
  createdAt: Date;
  originWorkspaceId?: string | null;
  restoredFromCheckpointId?: string | null;
  sourceDescriptor?: SourceDescriptor | null;
  resolvedSource?: ResolvedSource | null;
  persistenceCapability?: ConversationRestoreCapability;
  latestCheckpointId?: string | null;
  launchMode?: LaunchMode;
  outputs?: Record<string, unknown>;
}

export type WorkspaceInsertResult =
  | { kind: "created" | "replayed"; workspace: WorkspaceRow }
  | {
      kind: "conflict";
      conflict: "idempotency" | "external_id";
      workspace: WorkspaceRow;
    }
  | { kind: "capacity_exceeded" };

export type WorkspacePatch = Partial<
  Pick<
    WorkspaceRow,
    | "terminalIntent"
    | "launchInput"
    | "providerKind"
    | "providerRef"
    | "provisioningMode"
    | "registrationDigest"
    | "registrationExpiresAt"
    | "reconnectDigest"
    | "connectionEpoch"
    | "connectedAt"
    | "disconnectedAt"
    | "readyAt"
    | "lastActivityAt"
    | "launchAttempts"
    | "health"
    | "agentState"
    | "networkState"
    | "failureLogTail"
    | "failureLogTailTruncated"
    | "failureLastLogSeq"
    | "resolvedSource"
    | "persistenceCapability"
    | "latestCheckpointId"
    | "outputs"
  >
>;

export interface TransitionRequest {
  from: readonly WorkspaceState[];
  to: WorkspaceState;
  reason?: ReasonCode | null;
  at: Date;
  patch?: WorkspacePatch;
}

export interface WorkspaceStore {
  insertWorkspace(row: WorkspaceInsert, options?: { maxQueuedWorkspaces?: number }): Promise<WorkspaceInsertResult>;
  getWorkspaceByIdempotency(principalId: string, idempotencyKey: string): Promise<WorkspaceRow | null>;
  getWorkspace(id: string): Promise<WorkspaceRow | null>;
  listWorkspaces(principalId: string, filter: WorkspaceListFilter): Promise<WorkspaceRow[]>;
  listQueuedHeads(): Promise<WorkspaceRow[]>;
  listNonterminal(): Promise<WorkspaceRow[]>;
  countActive(): Promise<ActiveCounts>;
  countQueued(): Promise<number>;
  claimWorkspaceAdmission(claim: WorkspaceAdmissionClaim): Promise<WorkspaceRow | null>;
  updateWorkspace(id: string, patch: WorkspacePatch, at: Date): Promise<void>;
  waitForWorkspaceChange(id: string, afterSeq: number, timeoutMs: number, signal?: AbortSignal): Promise<void>;
  // Atomic guarded transition: succeeds only when the current state is in
  // `from`, appends state history and the outbox event in the same commit.
  transition(id: string, req: TransitionRequest): Promise<WorkspaceRow | null>;
  listStateHistory(workspaceId: string): Promise<StateHistoryRow[]>;
}

export function purgedContentPatch() {
  return {
    launchInput: null,
    health: {},
    outputs: {},
    failureLogTail: null,
    failureLogTailTruncated: false,
    failureLastLogSeq: null,
    resolvedSource: null,
    registrationDigest: null,
    reconnectDigest: null,
  };
}
