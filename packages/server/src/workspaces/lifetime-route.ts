import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ApiError, LifetimeExtensionSchema, LifetimeReceiptSchema } from "@pstdio/pocketcoder-contracts";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import { type AppEnv, requireScope } from "../http/middleware";
import { COMMON_ERROR_RESPONSES } from "../http/shared-routes";
import type { WorkspaceService } from "./service";

export function registerLifetimeRoute(app: OpenAPIHono<AppEnv>, store: Store, service: WorkspaceService) {
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/workspaces/{id}/lifetime",
      operationId: "extendWorkspaceLifetime",
      tags: ["Workspaces"],
      middleware: [requireScope("workspaces:create")] as const,
      request: {
        params: z.object({ id: z.uuid() }),
        body: {
          required: true,
          content: { "application/json": { schema: LifetimeExtensionSchema } },
        },
      },
      responses: {
        200: {
          description: "Extended within the original lifetime ceiling",
          content: { "application/json": { schema: LifetimeReceiptSchema } },
        },
        ...COMMON_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const row = await service.getOwned(c.get("principal"), c.req.valid("param").id);
      const key = await store.getMachineKeyWithPrincipal(c.get("keyId"));
      const deadline = new Date(c.req.valid("json").deadlineAt);
      if (!key || (key.key.expiresAt && deadline > key.key.expiresAt))
        throw new ApiError("operation.conflict", "Lifetime extension exceeds current deployment or key authority.");
      return c.json(await store.extendWorkspaceDeadline(row.id, row.principalId, c.req.valid("json")), 200);
    },
  );
}
