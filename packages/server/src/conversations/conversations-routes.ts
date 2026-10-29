import { randomUUID } from "node:crypto";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  ApiError,
  ConversationListQuerySchema,
  ConversationPageSchema,
  ConversationRequestIdentitySchema,
  ConversationRequestReceiptSchema,
  OutputListQuerySchema,
  OutputPageSchema,
} from "@pstdio/pocketcoder-contracts";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import { type AppEnv, requireScope } from "../http/middleware";
import { decodeSequenceCursor, encodeCursor } from "../http/pagination";
import { COMMON_ERROR_RESPONSES } from "../http/shared-routes";
import type { PersistenceLimits } from "../persistence/persistence-base";
import type { WorkspaceService } from "../workspaces/service";
import { CONVERSATION_PROTOCOL, registerConversationDocumentRoutes } from "./conversation-document-routes";
import { conversationRetention, DEFAULT_CONVERSATION_RETENTION } from "./conversation-retention";
import type { LiveTurns } from "./live-turns";

export function registerConversationRoutes({
  app,
  store,
  service,
  liveTurns,
  limits,
}: {
  app: OpenAPIHono<AppEnv>;
  store: Store;
  service: WorkspaceService;
  liveTurns: LiveTurns;
  limits?: Pick<PersistenceLimits, "conversationRetention">;
}) {
  const retention = conversationRetention(limits?.conversationRetention ?? DEFAULT_CONVERSATION_RETENTION);
  registerConversationDocumentRoutes({ app, store, service, liveTurns });
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/workspaces/{id}/conversation/requests",
      operationId: "acceptConversationRequest",
      tags: ["Conversations"],
      middleware: [requireScope("conversations:write")] as const,
      request: {
        params: z.object({ id: z.uuid() }),
        body: { content: { "application/json": { schema: ConversationRequestIdentitySchema } }, required: true },
      },
      responses: {
        201: {
          description: "Accepted request identity receipt",
          content: { "application/json": { schema: ConversationRequestReceiptSchema } },
        },
        200: {
          description: "Previously accepted request identity receipt",
          content: { "application/json": { schema: ConversationRequestReceiptSchema } },
        },
        ...COMMON_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const workspace = await service.getOwned(c.get("principal"), c.req.valid("param").id);
      const result = await store.acceptConversationRequest(workspace.id, c.req.valid("json"), new Date());
      if (result.kind === "conflict")
        throw new ApiError(
          "idempotency.conflict",
          "This request ID already has a different accepted identity or fingerprint.",
        );
      return c.json(
        { kind: result.kind, identity: result.request.identity, accepted_at: result.request.acceptedAt.toISOString() },
        result.kind === "accepted" ? 201 : 200,
      );
    },
  );
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
      const keep = workspace.terminalAt
        ? retention({ conversationRetention: workspace.templateSnapshot.spec.persistence.conversationRetention })
        : null;
      const expiresAt = workspace.terminalAt && keep !== null ? new Date(workspace.terminalAt.getTime() + keep) : null;
      if (expiresAt && expiresAt <= new Date()) {
        throw new ApiError("conversation.expired", "Conversation history has expired.");
      }
      const { cursor, limit } = c.req.valid("query");
      const after = decodeSequenceCursor("conversation", cursor);
      const rows = await store.readWorkspaceConversation(workspace.id, after, limit + 1);
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return c.json(
        {
          items: items.map((row) => row.message),
          next_cursor: hasMore && last ? encodeCursor("conversation", last.position) : null,
          retention: { status: "retained" as const, expires_at: expiresAt?.toISOString() ?? null },
          protocol: CONVERSATION_PROTOCOL,
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
