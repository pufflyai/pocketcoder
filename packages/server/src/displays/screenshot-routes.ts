import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ApiError, ScreenshotResourceSchema } from "@pstdio/pocketcoder-contracts";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import { bodyLimit } from "hono/body-limit";
import { type AppEnv, requireScope } from "../http/middleware";
import { COMMON_ERROR_RESPONSES } from "../http/shared-routes";
import type { WorkspaceService } from "../workspaces/service";
import type { Screenshots } from "./screenshots";

export function registerScreenshotRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: { store: Store; service: WorkspaceService; screenshots?: Screenshots },
) {
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/workspaces/{id}/display/screenshot",
      operationId: "captureScreenshot",
      tags: ["Displays"],
      middleware: [requireScope("display:view"), bodyLimit({ maxSize: 1024 })] as const,
      request: {
        params: z.object({ id: z.uuid() }),
        body: { content: { "application/json": { schema: z.strictObject({}) } } },
      },
      responses: {
        201: {
          description: "Private screenshot output reference",
          content: { "application/json": { schema: ScreenshotResourceSchema } },
        },
        ...COMMON_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      if (!deps.screenshots) throw new ApiError("operation.conflict", "Screenshot storage is unavailable.");
      const id = c.req.valid("param").id;
      await deps.service.getOwned(c.get("principal"), id);
      const resource = await deps.screenshots.capture(id, c.get("keyId"), c.req.raw.signal);
      c.header("cache-control", "no-store");
      return c.json(resource, 201);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/workspaces/{id}/outputs/{outputId}/content",
      operationId: "downloadScreenshot",
      tags: ["Outputs"],
      middleware: [requireScope("outputs:read")] as const,
      request: { params: z.object({ id: z.uuid(), outputId: z.uuid() }) },
      responses: {
        200: {
          description: "Private PNG download",
          content: { "image/png": { schema: z.string().openapi({ format: "binary" }) } },
        },
        ...COMMON_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const { id, outputId } = c.req.valid("param");
      const workspace = await deps.service.getOwned(c.get("principal"), id);
      const output = await deps.store.binaryOutputs.get(outputId);
      if (!output || output.workspaceId !== workspace.id || workspace.purgeRequestedAt)
        throw new ApiError("workspace.not_found", "Unknown screenshot output.");
      const bytes = await deps.store.binaryOutputs.content(output.id, workspace.principalId);
      if (!bytes) throw new ApiError("workspace.not_found", "Unknown screenshot output.");
      return new Response(bytes, {
        headers: {
          "content-type": "image/png",
          "content-length": String(bytes.length),
          "content-disposition": `attachment; filename="screenshot-${output.id}.png"`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    },
  );
}
