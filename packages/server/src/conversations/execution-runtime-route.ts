import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ApiError, ExecutionRuntimeSchema } from "@pstdio/pocketcoder-contracts";
import { type AppEnv, requireScope } from "../http/middleware";
import { COMMON_ERROR_RESPONSES } from "../http/shared-routes";
import type { WorkspaceService } from "../workspaces/service";

export function registerExecutionRuntimeRoute(app: OpenAPIHono<AppEnv>, service: WorkspaceService) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/workspaces/{id}/execution-runtime",
      operationId: "getExecutionRuntime",
      tags: ["Executions"],
      middleware: [requireScope("services:relay")] as const,
      request: { params: z.object({ id: z.uuid() }) },
      responses: {
        200: {
          description: "Observed runtime and installed execution descriptor",
          content: { "application/json": { schema: ExecutionRuntimeSchema } },
        },
        ...COMMON_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const workspace = await service.getOwned(c.get("principal"), c.req.valid("param").id);
      const runtime = workspace.runtimeRegistration;
      if (!runtime?.template || !runtime.producer)
        throw new ApiError("operation.conflict", "Installed execution evidence is not available.");
      return c.json(
        {
          workspaceId: workspace.id,
          callerPrincipalId: workspace.principalId,
          incarnationId: runtime.incarnationId,
          template: runtime.template,
          producer: runtime.producer,
          readyAt: runtime.readyAt ?? null,
          endedAt: runtime.endedAt ?? null,
        },
        200,
      );
    },
  );
}
