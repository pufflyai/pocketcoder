import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ApiError, managed } from "@pstdio/pocketcoder-contracts";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import { MANAGED_ERROR_RESPONSES, managedBodyLimit } from "../http/managed-routes";
import { type AppEnv, requireScope } from "../http/middleware";

export function registerProfileRoutes(app: OpenAPIHono<AppEnv>, store: Store) {
  app.use("/v1/execution-profiles/*", managedBodyLimit(262144));
  app.use("/v1/credential-bindings/*", managedBodyLimit(16384));
  app.use("/v1/budget-scopes/:scopeId/grant", managedBodyLimit(16384));
  app.openapi(
    createRoute({
      method: "put",
      path: "/v1/execution-profiles/{profileId}/revisions/{revision}",
      operationId: "provisionExecutionProfile",
      tags: ["Managed administration"],
      middleware: [requireScope("admin")] as const,
      request: {
        params: z.object({ profileId: z.uuid(), revision: z.coerce.number().int().positive() }),
        query: z.object({ principalId: z.uuid() }),
        body: { content: { "application/json": { schema: managed.ExecutionProfileSchema } } },
      },
      responses: {
        200: {
          description: "Immutable profile revision",
          content: { "application/json": { schema: managed.ExecutionProfileSchema } },
        },
        ...MANAGED_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const input = c.req.valid("json"),
        params = c.req.valid("param");
      if (input.profileId !== params.profileId || input.revision !== params.revision)
        throw new ApiError("validation.invalid", "Profile path and body identities must match.");
      return c.json(
        await store.managed.authority.provisionProfile(c.get("keyId"), c.req.valid("query").principalId, input),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "put",
      path: "/v1/budget-scopes/{scopeId}/grant",
      operationId: "grantBudgetScope",
      tags: ["Managed administration"],
      middleware: [requireScope("admin")] as const,
      request: {
        params: z.object({ scopeId: z.uuid() }),
        body: { content: { "application/json": { schema: managed.managedSchemas.BudgetScopeGrant } } },
      },
      responses: { 204: { description: "Scope granted" }, ...MANAGED_ERROR_RESPONSES },
    }),
    async (c) => {
      const input = c.req.valid("json");
      await store.managed.authority.registerScope(
        c.get("keyId"),
        c.req.valid("param").scopeId,
        input.principalId,
        input.installation,
      );
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: "put",
      path: "/v1/credential-bindings/{bindingId}",
      operationId: "registerCredentialBinding",
      tags: ["Managed administration"],
      middleware: [requireScope("admin")] as const,
      request: {
        params: z.object({ bindingId: z.uuid() }),
        body: { content: { "application/json": { schema: managed.managedSchemas.CredentialBinding } } },
      },
      responses: { 204: { description: "Immutable credential binding registered" }, ...MANAGED_ERROR_RESPONSES },
    }),
    async (c) => {
      const input = c.req.valid("json");
      if (input.bindingId !== c.req.valid("param").bindingId)
        throw new ApiError("validation.invalid", "Binding identities must match.");
      await store.managed.authority.registerCredential(c.get("keyId"), {
        ...input,
        authorityExpiresAt: new Date(input.authorityExpiresAt),
      });
      return c.body(null, 204);
    },
  );
}
