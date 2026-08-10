import type {
  ConversationRestoreCapability,
  LaunchMode,
  ReasonCode,
  ResolvedSource,
  SourceDescriptor,
  TemplateSnapshot,
  TemplateSpec,
  WorkspaceState,
} from "@pstdio/pocketcoder-contracts";
import type {
  TemplateRow,
  WorkspaceCheckpointRow,
  WorkspaceOperationRow,
  WorkspaceRow,
  WorkspaceStorageRow,
} from "./rows";

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

export interface TransitionRequest {
  from: readonly WorkspaceState[];
  to: WorkspaceState;
  reason?: ReasonCode | null;
  at: Date;
  patch?: WorkspacePatch;
}

export interface TemplateUpsert {
  name: string;
  version: string;
  digest: string;
  description: string | null;
  spec: TemplateSpec;
}

export interface UpsertResult {
  row: TemplateRow;
  created: boolean;
  // True when the (name, version) exists with different content. Immutable
  // versions make this a deployment error.
  conflict: boolean;
}
