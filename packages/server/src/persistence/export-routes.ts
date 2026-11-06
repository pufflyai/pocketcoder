import type { OpenAPIHono } from "@hono/zod-openapi";
import { ApiError } from "@pstdio/pocketcoder-contracts";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import { type AppEnv, requireScope } from "../http/middleware";
import type { WorkspaceService } from "../workspaces/service";

export function registerExportRoutes(app: OpenAPIHono<AppEnv>, store: Store, service: WorkspaceService) {
  app.get("/v1/workspaces/:id/executions/:requestId/exports", requireScope("outputs:read"), async (c) => {
    const row = await service.getOwned(c.get("principal"), c.req.param("id"));
    const record = row.processExecution;
    if (record?.acceptance.execution.requestId !== c.req.param("requestId"))
      throw new ApiError("workspace.not_found", "Execution not found.");
    const manifest = record.collection;
    if (!manifest) return c.json({ state: "pending", collection: null }, 202);
    const expired = Date.parse(manifest.expiresAt) <= Date.now();
    return c.json(
      { state: "settled", collection: { ...manifest, publication: expired ? "expired" : manifest.publication } },
      200,
    );
  });
  app.get("/v1/workspaces/:id/exports/:objectId/content", requireScope("outputs:read"), async (c) => {
    const row = await service.getOwned(c.get("principal"), c.req.param("id"));
    const content = await store.exports.content(row.id, c.req.param("objectId"), row.principalId, new Date());
    if (!content) throw new ApiError("workspace.not_found", "Export content is unavailable or expired.");
    return new Response(content, {
      headers: { "content-type": "application/octet-stream", "cache-control": "no-store" },
    });
  });
  app.delete("/v1/workspaces/:id/exports/:exportId", requireScope("workspaces:purge"), async (c) => {
    const row = await service.getOwned(c.get("principal"), c.req.param("id"));
    const execution = row.processExecution?.acceptance.execution;
    if (!execution) throw new ApiError("workspace.not_found", "Export not found.");
    await store.exports.delete(execution, c.req.param("exportId"), row.principalId, new Date());
    return c.json({ storageCleanup: "complete" });
  });
}
