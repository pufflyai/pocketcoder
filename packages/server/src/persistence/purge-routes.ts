import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ApiError, OperationResourceSchema } from "@pstdio/pocketcoder-contracts";
import { bodyLimit } from "hono/body-limit";
import { type AppEnv, requireScope } from "../http/middleware";
import { COMMON_ERROR_RESPONSES, IdempotencyHeadersSchema } from "../http/shared-routes";
import { type PersistenceService, toOperationResource } from "./persistence";

export function registerPurgeRoutes(app: OpenAPIHono<AppEnv>, persistence: PersistenceService) {
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/workspaces/{id}/purge",
      operationId: "purgeWorkspace",
      tags: ["Workspaces"],
      middleware: [
        requireScope("workspaces:purge"),
        bodyLimit({
          maxSize: 1024,
          onError: () => {
            throw new ApiError("validation.invalid", "Purge requires an empty JSON object.");
          },
        }),
      ] as const,
      request: {
        params: z.object({ id: z.uuid() }),
        headers: IdempotencyHeadersSchema,
        body: { content: { "application/json": { schema: z.strictObject({}) } } },
      },
      responses: {
        202: {
          description: "Durable purge accepted",
          content: { "application/json": { schema: OperationResourceSchema } },
        },
        ...COMMON_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const operation = await persistence.purge(
        c.get("principal"),
        c.req.valid("param").id,
        c.req.valid("header")["Idempotency-Key"],
      );
      return c.json(toOperationResource(operation), 202);
    },
  );
}
