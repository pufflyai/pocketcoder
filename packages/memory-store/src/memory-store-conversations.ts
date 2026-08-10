import type {
  ConversationMessageRow,
  ConversationStateRow,
} from "@pstdio/pocketcoder-runtime-contracts";

import { MAX_CONVERSATION_BYTES, MAX_CONVERSATION_MESSAGES } from "./memory-store-base";
import { MemoryLogStore } from "./memory-store-logs";

export class MemoryConversationStore extends MemoryLogStore {
  async appendConversationMessage(
    input: Omit<ConversationMessageRow, "seq">,
  ): Promise<{ message: ConversationMessageRow; created: boolean }> {
    const state = this.conversationStates.get(input.workspaceId);
    if (state?.status === "deleted") throw new Error("conversation.deleted");
    const rows = this.conversations.get(input.workspaceId) ?? [];
    const existing = rows.find((row) => row.messageId === input.messageId);
    if (existing) return { message: { ...existing }, created: false };
    const storedBytes = this.conversationBytes.get(input.workspaceId) ?? 0;
    const inputBytes =
      Buffer.byteLength(input.content) + Buffer.byteLength(JSON.stringify(input.metadata));
    if (
      rows.length >= MAX_CONVERSATION_MESSAGES ||
      storedBytes + inputBytes > MAX_CONVERSATION_BYTES
    ) {
      throw new Error("conversation.quota_exceeded");
    }
    const message = { ...input, seq: (rows.at(-1)?.seq ?? 0) + 1 };
    rows.push(message);
    this.conversations.set(input.workspaceId, rows);
    this.conversationBytes.set(input.workspaceId, storedBytes + inputBytes);
    if (!state) {
      this.conversationStates.set(input.workspaceId, {
        workspaceId: input.workspaceId,
        status: "retained",
        expiresAt: null,
        deletedAt: null,
        updatedAt: input.createdAt,
      });
    }
    return { message: { ...message }, created: true };
  }

  async readConversation(
    workspaceId: string,
    afterSeq: number,
    limit: number,
  ): Promise<ConversationMessageRow[]> {
    return (this.conversations.get(workspaceId) ?? [])
      .filter((row) => row.seq > afterSeq)
      .slice(0, limit)
      .map((row) => ({ ...row, metadata: { ...row.metadata } }));
  }

  async getConversationState(workspaceId: string): Promise<ConversationStateRow | null> {
    const row = this.conversationStates.get(workspaceId);
    return row ? { ...row } : null;
  }

  async setConversationExpiry(workspaceId: string, expiresAt: Date, at: Date): Promise<void> {
    const current = this.conversationStates.get(workspaceId);
    if (current?.status === "deleted") return;
    this.conversationStates.set(workspaceId, {
      workspaceId,
      status: "retained",
      expiresAt,
      deletedAt: null,
      updatedAt: at,
    });
  }

  async deleteConversation(workspaceId: string, at: Date): Promise<void> {
    this.conversations.delete(workspaceId);
    this.conversationBytes.delete(workspaceId);
    this.conversationStates.set(workspaceId, {
      workspaceId,
      status: "deleted",
      expiresAt: null,
      deletedAt: at,
      updatedAt: at,
    });
  }

  async pruneExpiredConversations(at: Date): Promise<number> {
    let deleted = 0;
    for (const state of this.conversationStates.values()) {
      if (state.status !== "retained" || !state.expiresAt || state.expiresAt > at) continue;
      if ((this.conversations.get(state.workspaceId)?.length ?? 0) > 0) deleted += 1;
      this.conversations.delete(state.workspaceId);
      this.conversationBytes.delete(state.workspaceId);
    }
    return deleted;
  }

  // --- Outbox ---
}
