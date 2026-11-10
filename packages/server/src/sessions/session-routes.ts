import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { managed } from "@pstdio/pocketcoder-contracts";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import { MANAGED_ERROR_RESPONSES, managedBodyLimit } from "../http/managed-routes";
import { type AppEnv, requireScope } from "../http/middleware";

export function registerSessionRoutes(app: OpenAPIHono<AppEnv>, store: Store) {
  app.use("/v1/sessions", managedBodyLimit(16384));
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/sessions",
      operationId: "createManagedSession",
      tags: ["Managed sessions"],
      middleware: [requireScope("sessions:write")] as const,
      request: { body: { content: { "application/json": { schema: managed.SessionCreateSchema } } } },
      responses: {
        200: {
          description: "Created or replayed logical session",
          content: { "application/json": { schema: managed.SessionSchema } },
        },
        ...MANAGED_ERROR_RESPONSES,
      },
    }),
    async (c) => c.json(await store.managed.sessions.create(c.get("keyId"), c.req.valid("json")), 200),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/sessions/{sessionId}",
      operationId: "getManagedSession",
      tags: ["Managed sessions"],
      middleware: [requireScope("sessions:read")] as const,
      request: { params: z.object({ sessionId: z.uuid() }) },
      responses: {
        200: { description: "Logical session", content: { "application/json": { schema: managed.SessionSchema } } },
        ...MANAGED_ERROR_RESPONSES,
      },
    }),
    async (c) => c.json(await store.managed.sessions.get(c.get("keyId"), c.req.valid("param").sessionId), 200),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/sessions/{sessionId}/resume",
      operationId: "resumeManagedSession",
      tags: ["Managed sessions"],
      middleware: [requireScope("sessions:write")] as const,
      request: { params: z.object({ sessionId: z.uuid() }) },
      responses: {
        200: {
          description: "Resume recorded; placement continues in the background",
          content: { "application/json": { schema: managed.SessionSchema } },
        },
        ...MANAGED_ERROR_RESPONSES,
      },
    }),
    async (c) =>
      c.json(await store.managed.recovery.resume(c.get("keyId"), c.req.valid("param").sessionId, new Date()), 200),
  );
}
