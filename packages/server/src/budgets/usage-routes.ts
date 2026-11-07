import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { managed } from "@pstdio/pocketcoder-contracts";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import { MANAGED_ERROR_RESPONSES } from "../http/managed-routes";
import { type AppEnv, requireScope } from "../http/middleware";

export function registerBudgetUsageRoutes(app: OpenAPIHono<AppEnv>, store: Store) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/budget-scopes/{scopeId}/usage",
      operationId: "readBudgetUsage",
      tags: ["Runtime budgets"],
      middleware: [requireScope("budgets:read")] as const,
      request: { params: z.object({ scopeId: z.uuid() }) },
      responses: {
        200: {
          description: "Consistent settled and outstanding usage",
          content: { "application/json": { schema: managed.BudgetUsageSchema } },
        },
        ...MANAGED_ERROR_RESPONSES,
      },
    }),
    async (c) => c.json(await store.managed.budgets.usage(c.get("keyId"), c.req.valid("param").scopeId), 200),
  );
}
