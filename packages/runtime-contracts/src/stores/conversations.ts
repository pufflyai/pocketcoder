import type {
  ConversationMessageIdentity,
  ConversationMessageResource,
  ConversationRecordDocument,
  ConversationRecordStatus,
  ConversationRequestIdentity,
  ConversationRole,
} from "@pstdio/pocketcoder-contracts";

export interface ConversationRequestRow {
  principalId: string;
  identity: ConversationRequestIdentity;
  acceptedAt: Date;
  execution: import("@pstdio/pocketcoder-contracts").ExecutionRecord | null;
}

export type ConversationRequestResult = {
  kind: "accepted" | "replayed" | "conflict";
  request: ConversationRequestRow;
};

// One message as a producer sends it, before the store gives it a position.
export interface ConversationMessageRow {
  workspaceId: string;
  messageId: string;
  role: ConversationRole;
  content: string;
  occurredAt: Date;
  metadata: Record<string, string>;
  identity?: ConversationMessageIdentity | null;
  createdAt: Date;
}

// Workspace-level marker for the whole history of one workspace.
export interface ConversationStateRow {
  workspaceId: string;
  status: "retained" | "deleted";
  expiresAt: Date | null;
  deletedAt: Date | null;
  updatedAt: Date;
}

export interface ConversationDocumentRow {
  id: string;
  principalId: string;
  conversationId: string | null;
  workspaceId: string;
  legacy: boolean;
  status: "retained" | "deleted" | "expired";
  recordCount: number;
  messageCount: number;
  bytes: number;
  lastSeq: number;
  expiresAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationRecordRow {
  id: number;
  conversationRef: string;
  recordSeq: number;
  recordKey: string;
  workspaceId: string;
  firstSeq: number;
  lastSeq: number;
  status: ConversationRecordStatus;
  document: ConversationRecordDocument;
  bytes: number;
  createdAt: Date;
}

// A finished turn: the final revision of each message, in order. One write per turn.
export interface ConversationTurnCommit {
  workspaceId: string;
  identity: ConversationRequestIdentity;
  status: Exclude<ConversationRecordStatus, "message" | "legacy">;
  reason: string | null;
  messages: Omit<ConversationMessageRow, "workspaceId" | "createdAt">[];
  startedAt: Date | null;
  endedAt: Date;
}

// A message of one workspace's history, with a cursor position across its records.
export interface WorkspaceConversationMessage {
  position: number;
  message: ConversationMessageResource;
}

// Template retention in milliseconds after the conversation's last workspace ended;
// null keeps history until it is deleted.
export type ConversationRetention = (workspace: { conversationRetention: string }) => number | null;

export interface ConversationStore {
  acceptConversationRequest(
    workspaceId: string,
    identity: ConversationRequestIdentity,
    at: Date,
  ): Promise<ConversationRequestResult>;
  // Producers may only write turns that a caller's request opened.
  isAcceptedTurn(workspaceId: string, identity: ConversationRequestIdentity): Promise<boolean>;
  commitConversationTurn(turn: ConversationTurnCommit): Promise<{ record: ConversationRecordRow; created: boolean }>;
  // Messages without identity have no turn; each one is its own record in the workspace history.
  appendWorkspaceMessage(message: ConversationMessageRow): Promise<{ record: ConversationRecordRow; created: boolean }>;
  readWorkspaceConversation(
    workspaceId: string,
    afterPosition: number,
    limit: number,
  ): Promise<WorkspaceConversationMessage[]>;
  listConversations(workspaceId: string): Promise<ConversationDocumentRow[]>;
  getConversation(principalId: string, conversationId: string): Promise<ConversationDocumentRow | null>;
  readConversationMessages(
    conversationRef: string,
    afterSeq: number,
    limit: number,
  ): Promise<ConversationMessageResource[]>;
  readConversationRecords(conversationRef: string): Promise<ConversationRecordRow[]>;
  getConversationState(workspaceId: string): Promise<ConversationStateRow | null>;
  // Deletes every conversation this workspace wrote to.
  deleteConversation(workspaceId: string, at: Date): Promise<void>;
  deleteConversationById(principalId: string, conversationId: string, at: Date): Promise<boolean>;
  // A receipt without a stored turn after a restart is a turn the controller lost.
  recordInterruptedTurns(at: Date): Promise<number>;
  pruneExpiredConversations(at: Date, retention: ConversationRetention): Promise<number>;
}
