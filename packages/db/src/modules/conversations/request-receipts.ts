import {
  type ConversationRequestIdentity,
  ConversationRequestIdentitySchema,
  canonicalJson,
} from "@pstdio/pocketcoder-contracts";
import type { ConversationMessageRow, ConversationRequestResult } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { requiredRow } from "../../database/required-row";
import { requireContentWritable } from "../persistence/content";

export function createConversationRequests(context: DatabaseContext) {
  const {
    db,
    tables: { conversationRequests: requests, workspaces },
  } = context;
  return {
    async acceptConversationRequest(workspaceId: string, identity: ConversationRequestIdentity, at: Date) {
      identity = ConversationRequestIdentitySchema.parse(identity);
      return db.transaction(async (tx) => {
        await requireContentWritable(tx, context.tables, workspaceId);
        const [workspace] = await tx
          .select({ principalId: workspaces.principalId })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId));
        const principalId = requiredRow(workspace).principalId;
        const [inserted] = await tx
          .insert(requests)
          .values({
            principalId,
            conversationId: identity.conversation_id,
            requestId: identity.request_id,
            identity,
            acceptedAt: at,
          })
          .onConflictDoNothing({ target: [requests.principalId, requests.conversationId, requests.requestId] })
          .returning();
        if (inserted) return { kind: "accepted", request: inserted } satisfies ConversationRequestResult;
        const [existing] = await tx
          .select()
          .from(requests)
          .where(
            and(
              eq(requests.principalId, principalId),
              eq(requests.conversationId, identity.conversation_id),
              eq(requests.requestId, identity.request_id),
            ),
          );
        const request = requiredRow(existing);
        return {
          kind: canonicalJson(request.identity) === canonicalJson(identity) ? "replayed" : "conflict",
          request,
        } satisfies ConversationRequestResult;
      });
    },
    async requireAccepted(tx: Transaction, input: Omit<ConversationMessageRow, "seq">) {
      if (input.identity) {
        const identity = ConversationRequestIdentitySchema.parse(input.identity);
        const [workspace] = await tx
          .select({ principalId: workspaces.principalId })
          .from(workspaces)
          .where(eq(workspaces.id, input.workspaceId));
        const [accepted] = await tx
          .select()
          .from(requests)
          .where(
            and(
              eq(requests.principalId, requiredRow(workspace).principalId),
              eq(requests.conversationId, identity.conversation_id),
              eq(requests.requestId, identity.request_id),
            ),
          );
        if (!accepted || canonicalJson(accepted.identity) !== canonicalJson(identity)) {
          throw new Error("conversation.request_not_accepted");
        }
      }
    },
  };
}
