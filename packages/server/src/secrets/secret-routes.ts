import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import {
  ApiError,
  ErrorEnvelopeSchema,
  SecretListSchema,
  SecretParamsSchema,
  SecretPutRequestSchema,
  SecretResourceSchema,
} from "@pstdio/pocketcoder-contracts";
import { bodyLimit } from "hono/body-limit";
import { type AppEnv, requireScope } from "../http/middleware";
import { COMMON_ERROR_RESPONSES } from "../http/shared-routes";
import type { createSecretVault } from "./secret-vault";

function validate(result: { success: boolean }) {
  // Validation errors can contain submitted values and unknown object keys.
  if (!result.success) throw new ApiError("validation.invalid", "Invalid stored secret request.");
  return undefined;
}

export function registerSecretRoutes(app: OpenAPIHono<AppEnv>, vault: ReturnType<typeof createSecretVault>) {
  for (const path of ["/v1/secrets", "/v1/secrets/*"]) {
    app.use(path, requireScope("secrets:write"));
    app.use(
      path,
      bodyLimit({
        maxSize: 65_536,
        onError() {
          throw new ApiError("request.body_too_large", "Stored secret request exceeds 65536 bytes.");
        },
      }),
    );
    app.use(path, async (c, next) => {
      if (c.req.method === "PUT") {
        try {
          await c.req.json();
        } catch {
          throw new ApiError("validation.invalid", "Invalid stored secret request.");
        }
      }
      await next();
    });
  }
  const content = { "application/json": { schema: SecretResourceSchema } };
  app.openapi(
    createRoute({
      method: "put",
      path: "/v1/secrets/{name}",
      operationId: "putSecret",
      tags: ["Secrets"],
      request: {
        params: SecretParamsSchema,
        body: { required: true, content: { "application/json": { schema: SecretPutRequestSchema } } },
      },
      responses: {
        200: { description: "Encrypted secret saved; only metadata returned", content },
        ...COMMON_ERROR_RESPONSES,
        413: {
          description: "Request body exceeds limit",
          content: { "application/json": { schema: ErrorEnvelopeSchema } },
        },
      },
    }),
    async (c) => c.json(await vault.put(c.get("keyId"), c.req.valid("param").name, c.req.valid("json")), 200),
    validate,
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/secrets",
      operationId: "listSecrets",
      tags: ["Secrets"],
      responses: {
        200: {
          description: "Instance-wide secret metadata, including retired names",
          content: { "application/json": { schema: SecretListSchema } },
        },
        ...COMMON_ERROR_RESPONSES,
      },
    }),
    async (c) => c.json({ items: await vault.list(c.get("keyId")) }, 200),
    validate,
  );
  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/secrets/{name}",
      operationId: "retireSecret",
      tags: ["Secrets"],
      request: { params: SecretParamsSchema },
      responses: {
        200: { description: "Secret retired for new resolution; old encrypted versions retained", content },
        404: { description: "Unknown secret", content: { "application/json": { schema: ErrorEnvelopeSchema } } },
        ...COMMON_ERROR_RESPONSES,
      },
    }),
    async (c) => c.json(await vault.retire(c.get("keyId"), c.req.valid("param").name), 200),
    validate,
  );
}
