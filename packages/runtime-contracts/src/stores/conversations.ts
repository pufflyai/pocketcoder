import type { ConversationRole } from "@pstdio/pocketcoder-contracts";

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

export interface ConversationStore {
  appendConversationMessage(
    row: Omit<ConversationMessageRow, "seq">,
  ): Promise<{ message: ConversationMessageRow; created: boolean }>;
  readConversation(workspaceId: string, afterSeq: number, limit: number): Promise<ConversationMessageRow[]>;
  getConversationState(workspaceId: string): Promise<ConversationStateRow | null>;
  setConversationExpiry(workspaceId: string, expiresAt: Date, at: Date): Promise<void>;
  deleteConversation(workspaceId: string, at: Date): Promise<void>;
  pruneExpiredConversations(at: Date): Promise<number>;
}
