import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  ApiError,
  PrincipalCreateRequestSchema,
  PrincipalListResponseSchema,
  PrincipalResourceSchema,
  PrincipalUpdateRequestSchema,
} from "@pstdio/pocketcoder-contracts";
import type { PrincipalRow, Store } from "@pstdio/pocketcoder-runtime-core";
import { bodyLimit } from "hono/body-limit";
import { type AppEnv, requireScope } from "../http/middleware";
import { COMMON_ERROR_RESPONSES } from "../http/shared-routes";
import { principalVisible } from "./principal-authority";

function principalResource(principal: PrincipalRow) {
  return {
    id: principal.id,
    name: principal.name,
    scopes: principal.scopes,
    templates: principal.templateNames,
    disabled_at: principal.disabledAt?.toISOString() ?? null,
    created_at: principal.createdAt.toISOString(),
  };
}

export function registerPrincipalRoutes(app: OpenAPIHono<AppEnv>, store: Store) {
  const limit = bodyLimit({
    maxSize: 16_384,
    onError: () => {
      throw new ApiError("validation.invalid", "Request body exceeds 16384 bytes.");
    },
  });
  app.use("/v1/principals", limit);
  app.use("/v1/principals/*", limit);
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/principals",
      operationId: "createPrincipal",
      tags: ["Principals"],
      middleware: [requireScope("principals:admin")] as const,
      request: { body: { content: { "application/json": { schema: PrincipalCreateRequestSchema } } } },
      responses: {
        201: { description: "Principal created", content: { "application/json": { schema: PrincipalResourceSchema } } },
        ...COMMON_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const principal = await store.createManagedPrincipal(c.get("keyId"), body.name, body.scopes, body.templates);
      return c.json(principalResource(principal), 201);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/principals",
      operationId: "listPrincipals",
      tags: ["Principals"],
      middleware: [requireScope("principals:admin")] as const,
      responses: {
        200: {
          description: "Principal grants",
          content: { "application/json": { schema: PrincipalListResponseSchema } },
        },
        ...COMMON_ERROR_RESPONSES,
      },
    }),
    async (c) =>
      c.json(
        {
          items: (await store.listPrincipals())
            .filter((principal) => principalVisible(c, principal))
            .map(principalResource),
        },
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/principals/{principalId}",
      operationId: "getPrincipal",
      tags: ["Principals"],
      middleware: [requireScope("principals:admin")] as const,
      request: { params: z.object({ principalId: z.uuid() }) },
      responses: {
        200: { description: "Principal grants", content: { "application/json": { schema: PrincipalResourceSchema } } },
        ...COMMON_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const principal = await store.getPrincipal(c.req.valid("param").principalId);
      if (!principal || !principalVisible(c, principal))
        throw new ApiError("principal.not_found", "Unknown principal.");
      return c.json(principalResource(principal), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/principals/{principalId}",
      operationId: "updatePrincipal",
      tags: ["Principals"],
      middleware: [requireScope("principals:admin")] as const,
      request: {
        params: z.object({ principalId: z.uuid() }),
        body: { content: { "application/json": { schema: PrincipalUpdateRequestSchema } } },
      },
      responses: {
        200: {
          description: "Updated principal grants",
          content: { "application/json": { schema: PrincipalResourceSchema } },
        },
        ...COMMON_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const principal = await store.updateManagedPrincipal(c.get("keyId"), c.req.valid("param").principalId, {
        scopes: body.scopes,
        templateNames: body.templates,
        disabled: body.disabled,
      });
      return c.json(principalResource(principal), 200);
    },
  );
}
