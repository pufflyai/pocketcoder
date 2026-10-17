import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  ApiError,
  ExecutionCancelSchema,
  ExecutionRecordSchema,
  ExecutionStartSchema,
  JsonValueSchema,
  WorkloadExecutionReferenceSchema,
  WorkloadInputPropertySchema,
} from "@pstdio/pocketcoder-contracts";
import type { ExecutionDispatcher, Store } from "@pstdio/pocketcoder-runtime-core";
import { type AppEnv, requireScope } from "../http/middleware";
import { COMMON_ERROR_RESPONSES } from "../http/shared-routes";
import type { WorkspaceService } from "../workspaces/service";

import { registerExecutionRuntimeRoute } from "./execution-runtime-route";

export function registerExecutionRoutes(deps: {
  app: OpenAPIHono<AppEnv>;
  store: Store;
  service: WorkspaceService;
  executionDispatcher: ExecutionDispatcher;
}) {
  const { app, store, service } = deps;
  // Contracts can load before Hono extends Zod. Apply its public extension to
  // the existing lazy schemas so recursive references share the registered names.
  const json = z.ZodType.prototype.openapi.call(JsonValueSchema, "ExecutionJson");
  const property = z.ZodType.prototype.openapi.call(WorkloadInputPropertySchema, "WorkloadInputProperty");
  app.openAPIRegistry.register("ExecutionJson", json);
  app.openAPIRegistry.register("WorkloadInputProperty", property);
  registerExecutionRuntimeRoute(app, service);
  const response = {
    description: "Durable execution intent and observed dispatch state",
    content: { "application/json": { schema: ExecutionRecordSchema } },
  };
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/workspaces/{id}/executions",
      operationId: "startExecution",
      tags: ["Executions"],
      middleware: [requireScope("services:relay")] as const,
      request: {
        params: z.object({ id: z.uuid() }),
        body: { required: true, content: { "application/json": { schema: ExecutionStartSchema } } },
      },
      responses: { 201: response, 200: response, ...COMMON_ERROR_RESPONSES },
    }),
    async (c) => {
      const workspace = await service.getOwned(c.get("principal"), c.req.valid("param").id);
      const { acceptance, conversationIdentity } = c.req.valid("json");
      if (acceptance.execution.workspaceId !== workspace.id || acceptance.callerPrincipalId !== workspace.principalId)
        throw new ApiError("operation.conflict", "Execution authority mismatch.");
      const result = await store.executions.accept(acceptance, new Date(), conversationIdentity);
      return c.json(result.record, result.kind === "accepted" ? 201 : 200);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/workspaces/{id}/executions/{requestId}",
      operationId: "observeExecution",
      tags: ["Executions"],
      middleware: [requireScope("services:relay")] as const,
      request: {
        params: z.object({ id: z.uuid(), requestId: z.uuid() }),
        query: z.object({ incarnationId: z.string().min(1), owner: WorkloadExecutionReferenceSchema.shape.owner }),
      },
      responses: { 200: response, ...COMMON_ERROR_RESPONSES },
    }),
    async (c) => {
      const { id, requestId } = c.req.valid("param");
      await service.getOwned(c.get("principal"), id);
      const record = await store.executions.get({ workspaceId: id, requestId, ...c.req.valid("query") });
      if (!record) throw new ApiError("workspace.not_found", "Execution was not accepted.");
      return c.json(record, 200);
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/workspaces/{id}/executions/{requestId}/cancel",
      operationId: "cancelExecution",
      tags: ["Executions"],
      middleware: [requireScope("services:relay")] as const,
      request: {
        params: z.object({ id: z.uuid(), requestId: z.uuid() }),
        body: { required: true, content: { "application/json": { schema: ExecutionCancelSchema } } },
      },
      responses: { 200: response, ...COMMON_ERROR_RESPONSES },
    }),
    async (c) => {
      const { id, requestId } = c.req.valid("param");
      await service.getOwned(c.get("principal"), id);
      const cancel = c.req.valid("json");
      if (cancel.execution.workspaceId !== id || cancel.execution.requestId !== requestId)
        throw new ApiError("operation.conflict", "Cancel target mismatch.");
      const record = await store.executions.cancel(cancel, new Date());
      deps.executionDispatcher.cancel(record);
      return c.json(record, 200);
    },
  );
}
