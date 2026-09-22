import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  ApiError,
  KeyIssueRequestSchema,
  KeyIssueResponseSchema,
  KeyListResponseSchema,
} from "@pstdio/pocketcoder-contracts";
import { issuePrincipalKey, keyResource, type Store } from "@pstdio/pocketcoder-runtime-core";
import { bodyLimit } from "hono/body-limit";
import { type AppEnv, requireScope } from "../http/middleware";
import { COMMON_ERROR_RESPONSES } from "../http/shared-routes";
import { managedPrincipal } from "./principal-authority";

const principalParams = z.object({ principalId: z.uuid() });
const revokedSchema = z.object({ revoked: z.literal(true) });

export function registerKeyRoutes(app: OpenAPIHono<AppEnv>, store: Store, pepper: string) {
  app.use(
    "/v1/principals/*",
    bodyLimit({
      maxSize: 16_384,
      onError: () => {
        throw new ApiError("validation.invalid", "Request body exceeds 16384 bytes.");
      },
    }),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/principals/{principalId}/keys",
      operationId: "listPrincipalKeys",
      tags: ["Keys"],
      middleware: [requireScope("keys:read")] as const,
      request: {
        params: principalParams,
        query: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(50),
          cursor: z.uuid().optional(),
          request_id: z.string().min(1).max(128).optional(),
        }),
      },
      responses: {
        200: {
          description: "Authoritative key metadata",
          content: { "application/json": { schema: KeyListResponseSchema } },
        },
        ...COMMON_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const principal = await managedPrincipal(c, store, c.req.valid("param").principalId);
      const query = c.req.valid("query");
      const keys = await store.listMachineKeys(principal.id, {
        limit: query.limit + 1,
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.request_id ? { requestId: query.request_id } : {}),
      });
      const items = keys.slice(0, query.limit).map((key) => keyResource(key, principal));
      return c.json({ items, next_cursor: keys.length > query.limit ? (items.at(-1)?.id ?? null) : null }, 200);
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/principals/{principalId}/keys",
      operationId: "issuePrincipalKey",
      tags: ["Keys"],
      middleware: [requireScope("keys:write")] as const,
      request: {
        params: principalParams,
        body: { content: { "application/json": { schema: KeyIssueRequestSchema } } },
      },
      responses: {
        200: {
          description: "Reconciled issuance; secret unavailable",
          content: { "application/json": { schema: KeyIssueResponseSchema } },
        },
        201: {
          description: "Issued key; secret shown once",
          content: { "application/json": { schema: KeyIssueResponseSchema } },
        },
        ...COMMON_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const principal = await managedPrincipal(c, store, c.req.valid("param").principalId);
      const result = await issuePrincipalKey(store, pepper, principal, c.req.valid("json"));
      return c.json({ key: result.key, token: result.token }, result.created ? 201 : 200);
    },
  );
  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/principals/{principalId}/keys/{keyId}",
      operationId: "revokePrincipalKey",
      tags: ["Keys"],
      middleware: [requireScope("keys:write")] as const,
      request: { params: principalParams.extend({ keyId: z.uuid() }) },
      responses: {
        200: { description: "Key revoked", content: { "application/json": { schema: revokedSchema } } },
        ...COMMON_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const { principalId, keyId } = c.req.valid("param");
      await managedPrincipal(c, store, principalId);
      const found = await store.getMachineKeyWithPrincipal(keyId);
      if (!found || found.key.principalId !== principalId) throw new ApiError("key.not_found", "Unknown key.");
      await store.revokeMachineKey(keyId, new Date());
      return c.json({ revoked: true as const }, 200);
    },
  );
  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/principals/{principalId}/keys",
      operationId: "revokeAllPrincipalKeys",
      tags: ["Keys"],
      middleware: [requireScope("keys:write")] as const,
      request: { params: principalParams },
      responses: {
        200: {
          description: "Principal disabled and all keys revoked atomically",
          content: { "application/json": { schema: revokedSchema } },
        },
        ...COMMON_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const principal = await managedPrincipal(c, store, c.req.valid("param").principalId);
      await store.revokePrincipalKeys(principal.id, new Date());
      return c.json({ revoked: true as const }, 200);
    },
  );
}
