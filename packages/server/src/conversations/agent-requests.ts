import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ApiError, digestOf, ExecutionRecordSchema, WorkspaceRequestSchema } from "@pstdio/pocketcoder-contracts";
import type { Store, WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
import { type AppEnv, requireScope } from "../http/middleware";
import { COMMON_ERROR_RESPONSES } from "../http/shared-routes";
import type { WorkspaceService } from "../workspaces/service";

function registration(workspace: WorkspaceRow) {
  const runtime = workspace.runtimeRegistration;
  const spec = runtime?.template?.manifest.spec;
  const producer = runtime?.producer;
  const operation = spec?.operations.message;
  const adapter = operation && producer?.adapters[operation.adapter];
  if (
    !runtime ||
    !producer ||
    runtime.profile !== "service" ||
    !operation ||
    adapter?.protocol !== "pocketcoder.execution/v1"
  )
    throw new ApiError("attachment.unsupported", "Choose an agent template with the input-aware message operation.");
  return { runtime, producer, adapter, template: runtime.template };
}

export function registerWorkspaceRequests(app: OpenAPIHono<AppEnv>, store: Store, service: WorkspaceService) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/workspaces/{id}/requests",
      tags: ["Agent"],
      operationId: "listWorkspaceRequests",
      middleware: [requireScope("services:relay")] as const,
      request: {
        params: z.object({ id: z.uuid() }),
        query: z.object({
          conversationId: z.uuid(),
          cursor: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(100),
        }),
      },
      responses: {
        200: {
          description: "Accepted requests in order",
          content: {
            "application/json": {
              schema: z.object({ items: z.array(ExecutionRecordSchema), next_cursor: z.uuid().nullable() }),
            },
          },
        },
        ...COMMON_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const row = await service.getOwned(c.get("principal"), c.req.valid("param").id);
      const page = await store.listConversationExecutions({
        workspaceId: row.id,
        principalId: row.principalId,
        ...c.req.valid("query"),
      });
      return c.json({ items: page.items, next_cursor: page.nextCursor }, 200);
    },
  );
  app.get("/v1/workspaces/:id/requests/capabilities", requireScope("services:relay"), async (c) => {
    const row = await service.getOwned(c.get("principal"), c.req.param("id"));
    try {
      const { producer } = registration(row);
      return c.json({
        requests: true,
        attachments: producer.capabilities.includes("immutable-inputs"),
      });
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "attachment.unsupported") throw error;
      return c.json({ requests: false, attachments: false });
    }
  });
  const responses = {
    200: { description: "Existing request", content: { "application/json": { schema: ExecutionRecordSchema } } },
    ...COMMON_ERROR_RESPONSES,
  };
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/workspaces/{id}/requests",
      tags: ["Agent"],
      operationId: "submitWorkspaceRequest",
      middleware: [requireScope("services:relay")] as const,
      request: {
        params: z.object({ id: z.uuid() }),
        body: { required: true, content: { "application/json": { schema: WorkspaceRequestSchema } } },
      },
      responses: {
        ...responses,
        201: { description: "Request accepted", content: { "application/json": { schema: ExecutionRecordSchema } } },
      },
    }),
    async (c) => {
      const row = await service.getOwned(c.get("principal"), c.req.valid("param").id);
      const input = c.req.valid("json");
      const { runtime, adapter, template } = registration(row);
      if (!template) throw new ApiError("workspace.not_ready", "Agent runtime is not installed.");
      const objects = { workspaceId: row.id, incarnationId: runtime.incarnationId, objects: input.files };
      const facts = {
        execution: {
          workspaceId: row.id,
          incarnationId: runtime.incarnationId,
          owner: "conversation-request" as const,
          requestId: input.requestId,
        },
        callerPrincipalId: row.principalId,
        templateDigest: template.digest,
        adapterDigest: adapter.digest,
        operation: "message",
        input: { message: input.message },
        inputs: { ...objects, digest: digestOf(objects) },
        bindingSetDigest: digestOf([]),
      };
      const identity = {
        schema: "pocketcoder.conversation/v2" as const,
        authority: "external" as const,
        conversation_id: input.conversationId,
        request_id: input.requestId,
        turn_id: input.requestId,
        request_fingerprint: digestOf(input).slice(7),
      };
      const result = await store.executions.accept({ ...facts, fingerprint: digestOf(facts) }, new Date(), identity);
      return c.json(result.record, result.kind === "accepted" ? 201 : 200);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/workspaces/{id}/requests/{requestId}",
      tags: ["Agent"],
      operationId: "readWorkspaceRequest",
      middleware: [requireScope("services:relay")] as const,
      request: {
        params: z.object({ id: z.uuid(), requestId: z.uuid() }),
        query: z.object({ conversationId: z.uuid() }),
      },
      responses,
    }),
    async (c) => {
      const { id, requestId } = c.req.valid("param");
      const row = await service.getOwned(c.get("principal"), id);
      const runtime = row.runtimeRegistration;
      const record =
        runtime &&
        (await store.executions.get({
          workspaceId: id,
          incarnationId: runtime.incarnationId,
          owner: "conversation-request",
          requestId,
        }));
      if (!record || record.conversationIdentity?.conversation_id !== c.req.valid("query").conversationId)
        throw new ApiError("workspace.not_found", "Agent request not found.");
      return c.json(record, 200);
    },
  );
}
