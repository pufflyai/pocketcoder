import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ApiError, managed } from "@pstdio/pocketcoder-contracts";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import { MANAGED_ERROR_RESPONSES, managedBodyLimit } from "../http/managed-routes";
import { type AppEnv, requireScope } from "../http/middleware";

export function registerBudgetPolicyRoutes(app: OpenAPIHono<AppEnv>, store: Store) {
  app.use("/v1/budget-scopes/*", managedBodyLimit(262144));
  app.openapi(
    createRoute({
      method: "put",
      path: "/v1/budget-scopes/{scopeId}/policy",
      operationId: "writeBudgetPolicy",
      tags: ["Runtime budgets"],
      middleware: [requireScope("budgets:admin")] as const,
      request: {
        params: z.object({ scopeId: z.uuid() }),
        body: { content: { "application/json": { schema: managed.BudgetPolicyWriteSchema } } },
      },
      responses: {
        200: {
          description: "Committed policy revision",
          content: { "application/json": { schema: managed.BudgetPolicySchema } },
        },
        ...MANAGED_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      if (input.scopeId !== c.req.valid("param").scopeId)
        throw new ApiError("validation.invalid", "Budget scope path and body must match.");
      const none = c.req.header("if-none-match"),
        match = c.req.header("if-match");
      if ((none && match) || (!none && !match) || (none && none !== "*") || (match && !/^"[1-9][0-9]*"$/.test(match)))
        throw new ApiError("revision.stale", "Use If-None-Match: * or If-Match with the current quoted revision.");
      const expected = match ? Number(match.slice(1, -1)) : null;
      const policy = await store.managed.budgets.writePolicy(c.get("keyId"), input, expected);
      c.header("etag", `"${policy.revision}"`);
      return c.json(policy, 200);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/budget-scopes/{scopeId}/policy",
      operationId: "readBudgetPolicy",
      tags: ["Runtime budgets"],
      middleware: [requireScope("budgets:read")] as const,
      request: { params: z.object({ scopeId: z.uuid() }) },
      responses: {
        200: { description: "Current policy", content: { "application/json": { schema: managed.BudgetPolicySchema } } },
        ...MANAGED_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const policy = await store.managed.budgets.readPolicy(c.get("keyId"), c.req.valid("param").scopeId);
      c.header("etag", `"${policy.revision}"`);
      return c.json(policy, 200);
    },
  );
}
