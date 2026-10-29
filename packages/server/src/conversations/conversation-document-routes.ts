import { randomUUID } from "node:crypto";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  ApiError,
  ConversationDocumentPageSchema,
  ConversationListQuerySchema,
  ConversationListSchema,
  type ConversationSummary,
} from "@pstdio/pocketcoder-contracts";
import type { ConversationDocumentRow, Store } from "@pstdio/pocketcoder-runtime-core";
import { type AppEnv, requireScope } from "../http/middleware";
import { decodeSequenceCursor, encodeCursor } from "../http/pagination";
import { COMMON_ERROR_RESPONSES } from "../http/shared-routes";
import type { WorkspaceService } from "../workspaces/service";
import { registerConversationLiveRoutes } from "./conversation-live-routes";
import type { LiveTurns } from "./live-turns";

export const CONVERSATION_PROTOCOL = {
  schema: "pocketcoder.conversation/v2" as const,
  request_identity_authorities: ["external" as const, "generic" as const],
  producer_capabilities: null,
};

function summary(row: ConversationDocumentRow): ConversationSummary {
  return {
    conversation_id: row.conversationId,
    workspace_id: row.workspaceId,
    legacy: row.legacy,
    status: row.status,
    message_count: row.messageCount,
    turn_count: row.recordCount,
    last_activity_at: row.updatedAt.toISOString(),
    expires_at: row.expiresAt?.toISOString() ?? null,
  };
}

const conversationParams = z.object({ id: z.uuid(), conversation_id: z.uuid() });

// Conversations are keyed by the caller's identity under the workspace owner, so one survives
// preserve, restore and resume across workspace generations.
export function registerConversationDocumentRoutes({
  app,
  store,
  service,
  liveTurns,
}: {
  app: OpenAPIHono<AppEnv>;
  store: Store;
  service: WorkspaceService;
  liveTurns: LiveTurns;
}) {
  async function owned(principal: Parameters<WorkspaceService["getOwned"]>[0], id: string, conversationId: string) {
    const workspace = await service.getOwned(principal, id);
    const document = await store.getConversation(workspace.principalId, conversationId);
    if (!document) throw new ApiError("conversation.not_found", "Conversation not found.");
    return { workspace, document };
  }

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/workspaces/{id}/conversations",
      operationId: "listWorkspaceConversations",
      tags: ["Conversations"],
      middleware: [requireScope("conversations:read")] as const,
      request: { params: z.object({ id: z.uuid() }) },
      responses: {
        200: {
          description: "Conversations this workspace or the workspaces it was restored from took part in",
          content: { "application/json": { schema: ConversationListSchema } },
        },
        ...COMMON_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const workspace = await service.getOwned(c.get("principal"), c.req.valid("param").id);
      return c.json({ items: (await store.listConversations(workspace.id)).map(summary) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/workspaces/{id}/conversations/{conversation_id}",
      operationId: "readWorkspaceConversation",
      tags: ["Conversations"],
      middleware: [requireScope("conversations:read")] as const,
      request: { params: conversationParams, query: ConversationListQuerySchema },
      responses: {
        200: {
          description: "One conversation document, paged by message sequence",
          content: { "application/json": { schema: ConversationDocumentPageSchema } },
        },
        ...COMMON_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const { id, conversation_id } = c.req.valid("param");
      const { document } = await owned(c.get("principal"), id, conversation_id);
      if (document.status === "deleted")
        throw new ApiError("conversation.deleted", "Conversation history was deleted.");
      if (document.status === "expired")
        throw new ApiError("conversation.expired", "Conversation history has expired.");
      const { cursor, limit } = c.req.valid("query");
      const after = decodeSequenceCursor("conversation", cursor);
      const messages = await store.readConversationMessages(document.id, after, limit + 1);
      const items = messages.slice(0, limit);
      const last = items.at(-1);
      return c.json(
        {
          items,
          next_cursor: messages.length > limit && last ? encodeCursor("conversation", last.seq) : null,
          conversation: summary(document),
          protocol: CONVERSATION_PROTOCOL,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/workspaces/{id}/conversations/{conversation_id}",
      operationId: "deleteConversation",
      tags: ["Conversations"],
      middleware: [requireScope("conversations:delete")] as const,
      request: { params: conversationParams },
      responses: {
        204: { description: "Conversation document deleted idempotently; other conversations stay" },
        ...COMMON_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const { id, conversation_id } = c.req.valid("param");
      const { workspace, document } = await owned(c.get("principal"), id, conversation_id);
      if (document.status === "deleted") return c.body(null, 204);
      const at = new Date();
      await store.deleteConversationById(workspace.principalId, conversation_id, at);
      await store.appendEvent(
        workspace.id,
        "workspace.conversation_deleted",
        {
          id: randomUUID(),
          type: "workspace.conversation_deleted",
          occurred_at: at.toISOString(),
          workspace_id: workspace.id,
          conversation_id,
        },
        at,
      );
      return c.body(null, 204);
    },
  );

  registerConversationLiveRoutes({ app, service, liveTurns });
}
