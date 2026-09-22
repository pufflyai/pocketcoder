import type { ConversationMessageRow, ConversationStateRow } from "@pstdio/pocketcoder-runtime-contracts";
import { MAX_CONVERSATION_BYTES, MAX_CONVERSATION_MESSAGES, type MemoryState } from "../../state/memory-store-base";

export class MemoryConversationStore {
  constructor(
    private readonly context: Pick<
      MemoryState,
      "conversationStates" | "conversations" | "conversationBytes" | "workspaces"
    >,
  ) {}
  async appendConversationMessage(
    input: Omit<ConversationMessageRow, "seq">,
  ): Promise<{ message: ConversationMessageRow; created: boolean }> {
    const state = this.context.conversationStates.get(input.workspaceId);
    if (state?.status === "deleted") throw new Error("conversation.deleted");
    if (this.context.workspaces.get(input.workspaceId)?.purgeRequestedAt) throw new Error("conversation.deleted");
    const rows = this.context.conversations.get(input.workspaceId) ?? [];
    const existing = rows.find((row) => row.messageId === input.messageId);
    if (existing) return { message: { ...existing }, created: false };
    const storedBytes = this.context.conversationBytes.get(input.workspaceId) ?? 0;
    const inputBytes = Buffer.byteLength(input.content) + Buffer.byteLength(JSON.stringify(input.metadata));
    if (rows.length >= MAX_CONVERSATION_MESSAGES || storedBytes + inputBytes > MAX_CONVERSATION_BYTES) {
      throw new Error("conversation.quota_exceeded");
    }
    const message = { ...input, seq: (rows.at(-1)?.seq ?? 0) + 1 };
    rows.push(message);
    this.context.conversations.set(input.workspaceId, rows);
    this.context.conversationBytes.set(input.workspaceId, storedBytes + inputBytes);
    if (!state) {
      this.context.conversationStates.set(input.workspaceId, {
        workspaceId: input.workspaceId,
        status: "retained",
        expiresAt: null,
        deletedAt: null,
        updatedAt: input.createdAt,
      });
    }
    return { message: { ...message }, created: true };
  }

  async readConversation(workspaceId: string, afterSeq: number, limit: number): Promise<ConversationMessageRow[]> {
    return (this.context.conversations.get(workspaceId) ?? [])
      .filter((row) => row.seq > afterSeq)
      .slice(0, limit)
      .map((row) => ({ ...row, metadata: { ...row.metadata } }));
  }

  async getConversationState(workspaceId: string): Promise<ConversationStateRow | null> {
    const row = this.context.conversationStates.get(workspaceId);
    return row ? { ...row } : null;
  }

  async setConversationExpiry(workspaceId: string, expiresAt: Date, at: Date): Promise<void> {
    const current = this.context.conversationStates.get(workspaceId);
    if (current?.status === "deleted") return;
    this.context.conversationStates.set(workspaceId, {
      workspaceId,
      status: "retained",
      expiresAt,
      deletedAt: null,
      updatedAt: at,
    });
  }

  async deleteConversation(workspaceId: string, at: Date): Promise<void> {
    this.context.conversations.delete(workspaceId);
    this.context.conversationBytes.delete(workspaceId);
    this.context.conversationStates.set(workspaceId, {
      workspaceId,
      status: "deleted",
      expiresAt: null,
      deletedAt: at,
      updatedAt: at,
    });
  }

  async pruneExpiredConversations(at: Date): Promise<number> {
    let deleted = 0;
    for (const state of this.context.conversationStates.values()) {
      if (state.status !== "retained" || !state.expiresAt || state.expiresAt > at) continue;
      if ((this.context.conversations.get(state.workspaceId)?.length ?? 0) > 0) deleted += 1;
      this.context.conversations.delete(state.workspaceId);
      this.context.conversationBytes.delete(state.workspaceId);
    }
    return deleted;
  }
}
