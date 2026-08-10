import type {
  CheckpointState,
  NetworkEventInput,
  OperationKind,
} from "@pstdio/pocketcoder-contracts";
import type {
  ActiveCounts,
  TemplateUpsert,
  TransitionRequest,
  UpsertResult,
  WorkspaceAdmissionClaim,
  WorkspaceCheckpointPatch,
  WorkspaceInsert,
  WorkspaceInsertResult,
  WorkspaceListFilter,
  WorkspaceOperationPatch,
  WorkspacePatch,
  WorkspaceStoragePatch,
} from "./mutations";
import type {
  CheckpointUsage,
  ConversationMessageRow,
  ConversationStateRow,
  LogRow,
  MachineKeyRow,
  NetworkEventRow,
  OutboxRow,
  PrincipalRow,
  StateHistoryRow,
  TemplateRow,
  TemplateStatus,
  TerminalSessionClose,
  TerminalSessionOpen,
  TerminalSessionRow,
  WarmPoolClaim,
  WarmPoolRuntimePatch,
  WarmPoolRuntimeRow,
  WorkspaceCheckpointRow,
  WorkspaceOperationRow,
  WorkspaceOutputRow,
  WorkspaceRow,
  WorkspaceStorageRow,
} from "./rows";

export interface StoreLifecycle {
  init(): Promise<void>;
  acquireCoordinatorLease(): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

export interface TemplateStore {
  upsertTemplate(input: TemplateUpsert): Promise<UpsertResult>;
  listTemplates(names: string[] | null): Promise<TemplateRow[]>;
  getTemplate(name: string, version?: string): Promise<TemplateRow | null>;
  setTemplateStatus(name: string, version: string, status: TemplateStatus): Promise<void>;
}

export interface WarmPoolStore {
  insertWarmPoolRuntime(row: WarmPoolRuntimeRow): Promise<WarmPoolRuntimeRow>;
  getWarmPoolRuntime(id: string): Promise<WarmPoolRuntimeRow | null>;
  listWarmPoolRuntimes(): Promise<WarmPoolRuntimeRow[]>;
  updateWarmPoolRuntime(id: string, patch: WarmPoolRuntimePatch, at: Date): Promise<void>;
  claimWarmPoolRuntime(
    claim: WarmPoolClaim,
  ): Promise<{ runtime: WarmPoolRuntimeRow; workspace: WorkspaceRow } | null>;
}

export interface AuthStore {
  createPrincipal(name: string, scopes: string[], templateNames: string[]): Promise<PrincipalRow>;
  getPrincipalByName(name: string): Promise<PrincipalRow | null>;
  listPrincipals(): Promise<PrincipalRow[]>;
  updatePrincipal(
    id: string,
    scopes: string[],
    templateNames: string[],
  ): Promise<PrincipalRow | null>;
  setPrincipalDisabled(id: string, disabled: boolean): Promise<void>;
  insertMachineKey(row: MachineKeyRow): Promise<void>;
  getMachineKeyWithPrincipal(
    keyId: string,
  ): Promise<{ key: MachineKeyRow; principal: PrincipalRow } | null>;
  revokeMachineKey(keyId: string, at: Date): Promise<boolean>;
  touchMachineKey(keyId: string, at: Date): Promise<void>;
}

export interface WorkspaceStore {
  insertWorkspace(
    row: WorkspaceInsert,
    options?: { maxQueuedWorkspaces?: number },
  ): Promise<WorkspaceInsertResult>;
  getWorkspaceByIdempotency(
    principalId: string,
    idempotencyKey: string,
  ): Promise<WorkspaceRow | null>;
  getWorkspace(id: string): Promise<WorkspaceRow | null>;
  listWorkspaces(principalId: string, filter: WorkspaceListFilter): Promise<WorkspaceRow[]>;
  listQueuedHeads(): Promise<WorkspaceRow[]>;
  listNonterminal(): Promise<WorkspaceRow[]>;
  countActive(): Promise<ActiveCounts>;
  countQueued(): Promise<number>;
  claimWorkspaceAdmission(claim: WorkspaceAdmissionClaim): Promise<WorkspaceRow | null>;
  updateWorkspace(id: string, patch: WorkspacePatch, at: Date): Promise<void>;
  waitForWorkspaceChange(
    id: string,
    afterSeq: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void>;
  // Atomic guarded transition: succeeds only when the current state is in
  // `from`, appends state history and the outbox event in the same commit.
  transition(id: string, req: TransitionRequest): Promise<WorkspaceRow | null>;
  listStateHistory(workspaceId: string): Promise<StateHistoryRow[]>;
}

export interface PersistenceStore {
  insertWorkspaceStorage(row: WorkspaceStorageRow): Promise<WorkspaceStorageRow>;
  getWorkspaceStorage(workspaceId: string): Promise<WorkspaceStorageRow | null>;
  getStorage(id: string): Promise<WorkspaceStorageRow | null>;
  updateWorkspaceStorage(id: string, patch: WorkspaceStoragePatch, at: Date): Promise<void>;
  insertCheckpoint(row: WorkspaceCheckpointRow): Promise<WorkspaceCheckpointRow>;
  getCheckpoint(id: string): Promise<WorkspaceCheckpointRow | null>;
  listCheckpoints(
    principalId: string,
    filter?: { workspaceId?: string; state?: CheckpointState },
  ): Promise<WorkspaceCheckpointRow[]>;
  updateCheckpoint(id: string, patch: WorkspaceCheckpointPatch, at: Date): Promise<void>;
  insertOperation(
    row: WorkspaceOperationRow,
    options?: { maxIncompleteOperations?: number },
  ): Promise<{ operation: WorkspaceOperationRow; created: boolean; conflict: boolean }>;
  getOperation(id: string): Promise<WorkspaceOperationRow | null>;
  getOperationByIdempotency(
    principalId: string,
    kind: OperationKind,
    idempotencyKey: string,
  ): Promise<WorkspaceOperationRow | null>;
  listIncompleteOperations(): Promise<WorkspaceOperationRow[]>;
  updateOperation(id: string, patch: WorkspaceOperationPatch, at: Date): Promise<void>;
  checkpointUsage(principalId: string | null): Promise<CheckpointUsage>;
  countIncompleteOperations(): Promise<number>;
}

export interface OutputStore {
  appendOutput(row: WorkspaceOutputRow): Promise<WorkspaceOutputRow>;
  listOutputs(workspaceId: string): Promise<WorkspaceOutputRow[]>;
}

export interface LogStore {
  appendLogs(
    workspaceId: string,
    entries: Array<{ stream: LogRow["stream"]; occurredAt: Date; content: Uint8Array }>,
  ): Promise<void>;
  readLogs(workspaceId: string, afterSeq: number, limit: number): Promise<LogRow[]>;
  readLogTail(
    workspaceId: string,
    maxBytes: number,
  ): Promise<{ content: Uint8Array; truncated: boolean; lastSeq: number | null }>;
}

export interface NetworkAuditStore {
  appendNetworkEvents(
    workspaceId: string,
    sourceSessionId: string,
    events: NetworkEventInput[],
  ): Promise<void>;
  readNetworkEvents(
    workspaceId: string,
    afterSeq: number,
    limit: number,
  ): Promise<NetworkEventRow[]>;
}

export interface ConversationStore {
  appendConversationMessage(
    row: Omit<ConversationMessageRow, "seq">,
  ): Promise<{ message: ConversationMessageRow; created: boolean }>;
  readConversation(
    workspaceId: string,
    afterSeq: number,
    limit: number,
  ): Promise<ConversationMessageRow[]>;
  getConversationState(workspaceId: string): Promise<ConversationStateRow | null>;
  setConversationExpiry(workspaceId: string, expiresAt: Date, at: Date): Promise<void>;
  deleteConversation(workspaceId: string, at: Date): Promise<void>;
  pruneExpiredConversations(at: Date): Promise<number>;
}

export interface TerminalAuditStore {
  openTerminalSession(
    row: TerminalSessionOpen,
    maxOpenSessions: number,
  ): Promise<TerminalSessionRow | null>;
  getTerminalSession(sessionId: string): Promise<TerminalSessionRow | null>;
  closeTerminalSession(
    sessionId: string,
    close: TerminalSessionClose,
  ): Promise<TerminalSessionRow | null>;
  listTerminalSessions(
    workspaceId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<TerminalSessionRow[]>;
}

export interface OutboxStore {
  claimDueEvents(now: Date, limit: number): Promise<OutboxRow[]>;
  markEventDelivered(id: string, at: Date): Promise<void>;
  markEventFailed(id: string, errorCode: string, nextAttemptAt: Date): Promise<void>;
  appendEvent(workspaceId: string, eventType: string, payload: unknown, at: Date): Promise<void>;
}

// Composition roots and complete adapters use the aggregate. Application
// services depend on the smallest capability intersection they need.
export interface Store
  extends StoreLifecycle,
    TemplateStore,
    WarmPoolStore,
    AuthStore,
    WorkspaceStore,
    PersistenceStore,
    OutputStore,
    LogStore,
    NetworkAuditStore,
    ConversationStore,
    TerminalAuditStore,
    OutboxStore {}
