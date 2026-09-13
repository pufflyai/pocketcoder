import type { ConversationMessageRow } from "@pstdio/pocketcoder-runtime-contracts";
import { and, asc, count, eq, gt, inArray, isNotNull, lte, ne, sql } from "drizzle-orm";
import { type DatabaseContext, lock } from "../../database/context";
import { requiredRow } from "../../database/required-row";

const MAX_CONVERSATION_BYTES = 50 * 1024 * 1024;
const MAX_CONVERSATION_MESSAGES = 100_000;
export function createConversations({
  db,
  tables: { workspaceConversations: conversations, workspaceConversationMessages: messages },
}: DatabaseContext) {
  return {
    async appendConversationMessage(input: Omit<ConversationMessageRow, "seq">) {
      return db.transaction(async (tx) => {
        await lock(tx, input.workspaceId, 7081);
        const [state] = await tx
          .select({ status: conversations.status })
          .from(conversations)
          .where(eq(conversations.workspaceId, input.workspaceId))
          .for("update");
        if (state?.status === "deleted") throw new Error("conversation.deleted");
        const [existing] = await tx
          .select()
          .from(messages)
          .where(and(eq(messages.workspaceId, input.workspaceId), eq(messages.messageId, input.messageId)));
        if (existing) return { message: existing, created: false };
        await tx
          .insert(conversations)
          .values({ workspaceId: input.workspaceId, status: "retained", updatedAt: input.createdAt })
          .onConflictDoNothing({ target: conversations.workspaceId });
        const [stats] = await tx
          .select({
            seq: sql`coalesce(max(${messages.seq}),0)`.mapWith(Number),
            count: count(),
            bytes:
              sql`coalesce(sum(octet_length(${messages.content})+octet_length(${messages.metadata}::text)),0)`.mapWith(
                Number,
              ),
          })
          .from(messages)
          .where(eq(messages.workspaceId, input.workspaceId));
        const inputBytes = Buffer.byteLength(input.content) + Buffer.byteLength(JSON.stringify(input.metadata));
        if (
          requiredRow(stats).count >= MAX_CONVERSATION_MESSAGES ||
          requiredRow(stats).bytes + inputBytes > MAX_CONVERSATION_BYTES
        )
          throw new Error("conversation.quota_exceeded");
        const [message] = await tx
          .insert(messages)
          .values({ ...input, seq: requiredRow(stats).seq + 1 })
          .returning();
        return { message: requiredRow(message), created: true };
      });
    },
    async readConversation(workspaceId: string, afterSeq: number, limit: number) {
      return db
        .select()
        .from(messages)
        .where(and(eq(messages.workspaceId, workspaceId), gt(messages.seq, afterSeq)))
        .orderBy(asc(messages.seq))
        .limit(limit);
    },
    async getConversationState(workspaceId: string) {
      const [row] = await db.select().from(conversations).where(eq(conversations.workspaceId, workspaceId));
      return row ?? null;
    },
    async setConversationExpiry(workspaceId: string, expiresAt: Date, at: Date) {
      await db
        .insert(conversations)
        .values({ workspaceId, status: "retained", expiresAt, updatedAt: at })
        .onConflictDoUpdate({
          target: conversations.workspaceId,
          set: { expiresAt, updatedAt: at },
          setWhere: ne(conversations.status, "deleted"),
        });
    },
    async deleteConversation(workspaceId: string, at: Date) {
      await db.transaction(async (tx) => {
        await tx.delete(messages).where(eq(messages.workspaceId, workspaceId));
        await tx
          .insert(conversations)
          .values({ workspaceId, status: "deleted", deletedAt: at, updatedAt: at })
          .onConflictDoUpdate({
            target: conversations.workspaceId,
            set: { status: "deleted", expiresAt: null, deletedAt: at, updatedAt: at },
          });
      });
    },
    async pruneExpiredConversations(at: Date) {
      const expired = db
        .select({ workspaceId: conversations.workspaceId })
        .from(conversations)
        .where(
          and(
            eq(conversations.status, "retained"),
            isNotNull(conversations.expiresAt),
            lte(conversations.expiresAt, at),
          ),
        );
      const rows = await db
        .delete(messages)
        .where(inArray(messages.workspaceId, expired))
        .returning({ workspaceId: messages.workspaceId });
      return new Set(rows.map((row) => row.workspaceId)).size;
    },
  };
}
