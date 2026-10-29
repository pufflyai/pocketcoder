import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { KeyIssueResponseSchema, KeyRotateRequestSchema } from "@pstdio/pocketcoder-contracts";
import { rotatePrincipalKey, type Store } from "@pstdio/pocketcoder-runtime-core";
import { type AppEnv, requireScope } from "../http/middleware";
import { COMMON_ERROR_RESPONSES } from "../http/shared-routes";
import { keyAdministrationPrincipal } from "./principal-authority";

// Rotation follows issuance authority: an owner key, or an automation key that names the principal.
export function registerKeyRotationRoutes(app: OpenAPIHono<AppEnv>, store: Store, pepper: string) {
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/principals/{principalId}/keys/{keyId}/rotate",
      operationId: "rotatePrincipalKey",
      tags: ["Keys"],
      middleware: [requireScope("keys:write")] as const,
      request: {
        params: z.object({ principalId: z.uuid(), keyId: z.uuid() }),
        body: { content: { "application/json": { schema: KeyRotateRequestSchema } } },
      },
      responses: {
        200: {
          description: "Reconciled rotation; secret unavailable",
          content: { "application/json": { schema: KeyIssueResponseSchema } },
        },
        201: {
          description: "Successor issued; secret shown once; the rotated key stays valid until revoked",
          content: { "application/json": { schema: KeyIssueResponseSchema } },
        },
        ...COMMON_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const { principalId, keyId } = c.req.valid("param");
      const principal = await keyAdministrationPrincipal(c, store, principalId);
      const result = await rotatePrincipalKey(store, pepper, principal, keyId, c.req.valid("json"), {
        actorKeyId: c.get("keyId"),
      });
      return c.json({ key: result.key, token: result.token }, result.created ? 201 : 200);
    },
  );
}
