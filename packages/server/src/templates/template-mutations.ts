import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import {
  ApiError,
  ErrorEnvelopeSchema,
  TemplateListItemSchema,
  TemplatePublishRequestSchema,
  TemplateVersionParamsSchema,
} from "@pstdio/pocketcoder-contracts";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import { bodyLimit } from "hono/body-limit";
import { type AppEnv, requireScope } from "../http/middleware";
import { COMMON_ERROR_RESPONSES } from "../http/shared-routes";
import { safeTemplateItem } from "./template-item";

export function registerTemplateMutations(app: OpenAPIHono<AppEnv>, store: Store, egressImage?: string | null) {
  app.use("/v1/templates", async (c, next) => {
    if (c.req.method === "POST") return requireScope("templates:write")(c, next);
    await next();
  });
  app.use(
    "/v1/templates",
    bodyLimit({
      maxSize: 1_048_576,
      onError: () => {
        throw new ApiError("request.body_too_large", "Template request exceeds 1048576 bytes.");
      },
    }),
  );
  app.use("/v1/templates", async (c, next) => {
    if (c.req.method === "POST") {
      try {
        await c.req.json();
      } catch {
        throw new ApiError("validation.invalid", "Template request must be valid JSON.");
      }
    }
    await next();
  });
  const content = { "application/json": { schema: TemplateListItemSchema } };
  const errors = {
    ...COMMON_ERROR_RESPONSES,
    409: {
      description: "Immutable template version conflict",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
    413: {
      description: "Request body exceeds limit",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
  };
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/templates",
      operationId: "publishTemplate",
      tags: ["Templates"],
      middleware: [requireScope("templates:write")] as const,
      request: { body: { required: true, content: { "application/json": { schema: TemplatePublishRequestSchema } } } },
      responses: {
        201: { description: "Template version published", content },
        200: { description: "Identical template version already exists", content },
        ...errors,
      },
    }),
    async (c) => {
      const { manifest } = c.req.valid("json");
      if (manifest.spec.network.mode === "restricted" && !egressImage) {
        throw new ApiError("validation.invalid", "Restricted templates require a configured POCKETCODER_EGRESS_IMAGE.");
      }
      const result = await store.publishTemplate(c.get("keyId"), manifest);
      return c.json(safeTemplateItem(result.row), result.created ? 201 : 200);
    },
  );
  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/templates/{name}/{version}",
      operationId: "retireTemplate",
      tags: ["Templates"],
      middleware: [requireScope("templates:write")] as const,
      request: { params: TemplateVersionParamsSchema },
      responses: {
        200: { description: "Template version retired; workspace snapshots preserved", content },
        404: {
          description: "Unknown template version",
          content: { "application/json": { schema: ErrorEnvelopeSchema } },
        },
        ...COMMON_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const { name, version } = c.req.valid("param");
      return c.json(safeTemplateItem(await store.retireTemplate(c.get("keyId"), name, version)), 200);
    },
  );
}
