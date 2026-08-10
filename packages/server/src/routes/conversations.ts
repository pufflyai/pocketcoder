import { randomUUID } from "node:crypto";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  ApiError,
  ConversationListQuerySchema,
  ConversationPageSchema,
  OutputListQuerySchema,
  OutputPageSchema,
  parseDurationMs,
} from "@pstdio/pocketcoder-contracts";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import { type AppEnv, requireScope } from "../middleware";
import { decodeSequenceCursor, encodeCursor } from "../pagination";
import type { WorkspaceService } from "../service";
import { COMMON_ERROR_RESPONSES } from "./shared";

export function registerConversationRoutes({
  app,
  store,
  service,
}: {
  app: OpenAPIHono<AppEnv>;
  store: Store;
  service: WorkspaceService;
}) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/workspaces/{id}/conversation",
      operationId: "listWorkspaceConversation",
      tags: ["Conversations"],
      middleware: [requireScope("conversations:read")] as const,
      request: {
        params: z.object({ id: z.uuid() }),
        query: ConversationListQuerySchema,
      },
      responses: {
        200: {
          description: "Durable conversation transcript for an active or terminal workspace",
          content: {
            "application/json": {
              schema: ConversationPageSchema,
            },
          },
        },
        ...COMMON_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const principal = c.get("principal");
      const workspace = await service.getOwned(principal, c.req.valid("param").id);
      const state = await store.getConversationState(workspace.id);
      if (state?.status === "deleted") {
        throw new ApiError("conversation.deleted", "Conversation history was deleted.");
      }
      const expiresAt =
        state?.expiresAt ??
        (workspace.terminalAt
          ? new Date(
              workspace.terminalAt.getTime() +
                parseDurationMs(workspace.templateSnapshot.spec.persistence.conversationRetention),
            )
          : null);
      if (expiresAt && expiresAt <= new Date()) {
        throw new ApiError("conversation.expired", "Conversation history has expired.");
      }
      const { cursor, limit } = c.req.valid("query");
      const after = decodeSequenceCursor("conversation", cursor);
      const rows = await store.readConversation(workspace.id, after, limit + 1);
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return c.json(
        {
          items: items.map((row) => ({
            message_id: row.messageId,
            seq: row.seq,
            role: row.role,
            content: row.content,
            occurred_at: row.occurredAt.toISOString(),
            metadata: row.metadata,
          })),
          next_cursor: hasMore && last ? encodeCursor("conversation", last.seq) : null,
          retention: { status: "retained" as const, expires_at: expiresAt?.toISOString() ?? null },
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/workspaces/{id}/conversation",
      operationId: "deleteWorkspaceConversation",
      tags: ["Conversations"],
      middleware: [requireScope("conversations:delete")] as const,
      request: { params: z.object({ id: z.uuid() }) },
      responses: {
        204: { description: "Conversation content deleted idempotently" },
        ...COMMON_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const principal = c.get("principal");
      const workspace = await service.getOwned(principal, c.req.valid("param").id);
      const at = new Date();
      const previous = await store.getConversationState(workspace.id);
      await store.deleteConversation(workspace.id, at);
      if (previous?.status !== "deleted") {
        await store.appendEvent(
          workspace.id,
          "workspace.conversation_deleted",
          {
            id: randomUUID(),
            type: "workspace.conversation_deleted",
            occurred_at: at.toISOString(),
            workspace_id: workspace.id,
          },
          at,
        );
      }
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/workspaces/{id}/outputs",
      operationId: "listWorkspaceOutputs",
      tags: ["Workspaces"],
      middleware: [requireScope("outputs:read")] as const,
      request: {
        params: z.object({ id: z.uuid() }),
        query: OutputListQuerySchema,
      },
      responses: {
        200: {
          description: "Append-only workspace outputs",
          content: {
            "application/json": {
              schema: OutputPageSchema,
            },
          },
        },
        ...COMMON_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const principal = c.get("principal");
      const { id } = c.req.valid("param");
      const { cursor, limit } = c.req.valid("query");
      const after = decodeSequenceCursor("outputs", cursor);
      await service.getOwned(principal, id);
      const rows = (await store.listOutputs(id)).filter((row) => row.seq > after);
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return c.json(
        {
          items: items.map((row) => ({
            seq: row.seq,
            name: row.name,
            value: row.value,
            occurred_at: row.occurredAt.toISOString(),
          })),
          next_cursor: hasMore && last ? encodeCursor("outputs", last.seq) : null,
        },
        200,
      );
    },
  );
}
