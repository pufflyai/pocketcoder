import {
  type ConversationRequestIdentity,
  ConversationRequestIdentitySchema,
  canonicalJson,
} from "@pstdio/pocketcoder-contracts";
import type { ConversationRequestResult } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq } from "drizzle-orm";
import type { DatabaseContext } from "../../database/context";
import { requiredRow } from "../../database/required-row";
import { requireContentWritable } from "../persistence/content";

// The accepting workspace is internal bookkeeping for restart recovery, not part of the receipt.
function receipt<Row extends { workspaceId: string | null }>({ workspaceId: _, ...request }: Row) {
  return request;
}

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
            workspaceId,
            identity,
            acceptedAt: at,
          })
          .onConflictDoNothing({ target: [requests.principalId, requests.conversationId, requests.requestId] })
          .returning();
        if (inserted) return { kind: "accepted", request: receipt(inserted) } satisfies ConversationRequestResult;
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
        const replayed = canonicalJson(request.identity) === canonicalJson(identity);
        // A resumed workspace replays the request; its unfinished turn now belongs there.
        if (replayed && request.workspaceId !== workspaceId)
          await tx
            .update(requests)
            .set({ workspaceId })
            .where(
              and(
                eq(requests.principalId, principalId),
                eq(requests.conversationId, identity.conversation_id),
                eq(requests.requestId, identity.request_id),
              ),
            );
        return {
          kind: replayed ? "replayed" : "conflict",
          request: receipt(request),
        } satisfies ConversationRequestResult;
      });
    },
    async isAccepted(workspaceId: string, identity: ConversationRequestIdentity) {
      const parsed = ConversationRequestIdentitySchema.parse(identity);
      const [workspace] = await db
        .select({ principalId: workspaces.principalId })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId));
      if (!workspace) return false;
      const [accepted] = await db
        .select()
        .from(requests)
        .where(
          and(
            eq(requests.principalId, workspace.principalId),
            eq(requests.conversationId, parsed.conversation_id),
            eq(requests.requestId, parsed.request_id),
          ),
        );
      return Boolean(accepted && canonicalJson(accepted.identity) === canonicalJson(parsed));
    },
  };
}
