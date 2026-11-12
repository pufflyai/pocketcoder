import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { managed } from "@pstdio/pocketcoder-contracts";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import { MANAGED_ERROR_RESPONSES } from "../http/managed-routes";
import { type AppEnv, requireScope } from "../http/middleware";

export function registerProfileRoutes(app: OpenAPIHono<AppEnv>, store: Store) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/session-profiles/{name}",
      operationId: "getSessionProfile",
      tags: ["Managed sessions"],
      middleware: [requireScope("sessions:read")] as const,
      request: { params: z.object({ name: managed.ProfileNameSchema }) },
      responses: {
        200: {
          description: "Configured session profile",
          content: { "application/json": { schema: managed.SessionProfileSchema } },
        },
        ...MANAGED_ERROR_RESPONSES,
      },
    }),
    async (c) => c.json(await store.managed.profiles.get(c.get("keyId"), c.req.valid("param").name), 200),
  );
}
