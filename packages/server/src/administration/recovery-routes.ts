import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ApiError, OperationResourceSchema } from "@pstdio/pocketcoder-contracts";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import { type AppEnv, requireScope } from "../http/middleware";
import { COMMON_ERROR_RESPONSES, IdempotencyHeadersSchema } from "../http/shared-routes";
import { type PersistenceService, toOperationResource } from "../persistence/persistence";
import { managedPrincipal } from "./principal-authority";

export function registerOperatorRecoveryRoutes(
  app: OpenAPIHono<AppEnv>,
  store: Store,
  persistence: PersistenceService,
) {
  const responses = {
    202: {
      description: "Recovery purge accepted",
      content: { "application/json": { schema: OperationResourceSchema } },
    },
    ...COMMON_ERROR_RESPONSES,
  };
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/principals/{principalId}/workspaces/{id}/purge",
      operationId: "recoverWorkspacePurge",
      tags: ["Recovery"],
      middleware: [requireScope("workspaces:recover")] as const,
      request: {
        params: z.object({ principalId: z.uuid(), id: z.uuid() }),
        headers: IdempotencyHeadersSchema,
        body: { content: { "application/json": { schema: z.strictObject({}) } } },
      },
      responses,
    }),
    async (c) => {
      const principal = await managedPrincipal(c, store, c.req.valid("param").principalId);
      return c.json(
        toOperationResource(
          await persistence.purge(principal, c.req.valid("param").id, c.req.valid("header")["Idempotency-Key"]),
        ),
        202,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/principals/{principalId}/operations/{id}",
      operationId: "getRecoveryOperation",
      tags: ["Recovery"],
      middleware: [requireScope("workspaces:recover")] as const,
      request: { params: z.object({ principalId: z.uuid(), id: z.uuid() }) },
      responses: { 200: responses[202], ...COMMON_ERROR_RESPONSES },
    }),
    async (c) => {
      const principal = await managedPrincipal(c, store, c.req.valid("param").principalId);
      const operation = await store.getOperation(c.req.valid("param").id);
      if (!operation || operation.principalId !== principal.id || operation.kind !== "purge")
        throw new ApiError("workspace.not_found", "Unknown operation.");
      return c.json(toOperationResource(operation), 200);
    },
  );
}
