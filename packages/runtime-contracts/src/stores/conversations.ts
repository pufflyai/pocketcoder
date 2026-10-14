import type {
  ConversationMessageIdentity,
  ConversationRequestIdentity,
  ConversationRole,
} from "@pstdio/pocketcoder-contracts";

export interface ConversationRequestRow {
  principalId: string;
  identity: ConversationRequestIdentity;
  acceptedAt: Date;
}

export type ConversationRequestResult = {
  kind: "accepted" | "replayed" | "conflict";
  request: ConversationRequestRow;
};

export interface ConversationMessageRow {
  workspaceId: string;
  seq: number;
  messageId: string;
  role: ConversationRole;
  content: string;
  occurredAt: Date;
  metadata: Record<string, string>;
  identity?: ConversationMessageIdentity | null;
  createdAt: Date;
}

export interface ConversationStateRow {
  workspaceId: string;
  status: "retained" | "deleted";
  expiresAt: Date | null;
  deletedAt: Date | null;
  updatedAt: Date;
}

export interface ConversationStore {
  acceptConversationRequest(
    workspaceId: string,
    identity: ConversationRequestIdentity,
    at: Date,
  ): Promise<ConversationRequestResult>;
  appendConversationMessage(
    row: Omit<ConversationMessageRow, "seq">,
  ): Promise<{ message: ConversationMessageRow; created: boolean }>;
  readConversation(workspaceId: string, afterSeq: number, limit: number): Promise<ConversationMessageRow[]>;
  getConversationState(workspaceId: string): Promise<ConversationStateRow | null>;
  setConversationExpiry(workspaceId: string, expiresAt: Date, at: Date): Promise<void>;
  deleteConversation(workspaceId: string, at: Date): Promise<void>;
  pruneExpiredConversations(at: Date): Promise<number>;
}
