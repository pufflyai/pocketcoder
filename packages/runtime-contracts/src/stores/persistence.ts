import type {
  CheckpointManifest,
  CheckpointState,
  ConversationRestoreCapability,
  OperationKind,
  OperationState,
  PersistenceMount,
  ResolvedSource,
  StorageState,
  TemplateSnapshot,
} from "@pstdio/pocketcoder-contracts";

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

export interface CheckpointUsage {
  count: number;
  logicalBytes: number;
}

export type WorkspaceStoragePatch = Partial<
  Pick<
    WorkspaceStorageRow,
    | "providerKind"
    | "providerRef"
    | "state"
    | "logicalBytes"
    | "fileCount"
    | "retainedUntil"
    | "deletedAt"
    | "lastErrorCode"
  >
>;

export type WorkspaceCheckpointPatch = Partial<
  Pick<
    WorkspaceCheckpointRow,
    | "state"
    | "reasonCode"
    | "providerKind"
    | "providerRef"
    | "manifest"
    | "manifestDigest"
    | "logicalBytes"
    | "storedBytes"
    | "fileCount"
    | "conversationRestore"
    | "readyAt"
    | "expiresAt"
    | "deletedAt"
  >
>;

export type WorkspaceOperationPatch = Partial<
  Pick<
    WorkspaceOperationRow,
    "state" | "checkpointId" | "resultWorkspaceId" | "reasonCode" | "attemptCount" | "completedAt"
  >
>;

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
