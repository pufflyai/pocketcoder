import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ApiError, artifactPath, isTerminal } from "@pstdio/pocketcoder-contracts";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import { type AppEnv, requireScope } from "../http/middleware";
import { COMMON_ERROR_RESPONSES } from "../http/shared-routes";
import type { WorkspaceService } from "../workspaces/service";
import type { PersistenceService } from "./persistence";

const notFound = () => new ApiError("artifact.not_found", "No such artifact in this workspace's latest checkpoint.");

// Template-declared private files, such as diagnostic transcripts, read from the latest
// checkpoint without resuming the workspace. They are never a source of conversation history.
export function registerArtifactRoutes({
  app,
  store,
  service,
  persistence,
}: {
  app: OpenAPIHono<AppEnv>;
  store: Store;
  service: WorkspaceService;
  persistence: PersistenceService;
}) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/workspaces/{id}/artifacts/{name}",
      operationId: "readWorkspaceArtifact",
      tags: ["Workspaces"],
      middleware: [requireScope("workspaces:read")] as const,
      request: {
        params: z.object({ id: z.uuid(), name: z.string().min(1).max(64) }),
        query: z.object({ key: z.string().max(128).optional() }),
      },
      responses: {
        200: {
          description: "The artifact bytes from the latest ready checkpoint",
          content: { "application/octet-stream": { schema: z.string() } },
        },
        ...COMMON_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const { id, name } = c.req.valid("param");
      const workspace = await service.getOwned(c.get("principal"), id);
      const artifact = workspace.templateSnapshot.spec.persistence.artifacts?.find((item) => item.name === name);
      const path = artifact ? artifactPath(artifact, c.req.valid("query").key) : null;
      if (!artifact || path === null) throw notFound();
      // A running harness owns the live file; read it through the harness's own relay route.
      if (!isTerminal(workspace.state))
        throw new ApiError(
          "artifact.workspace_active",
          "The workspace is running; read the live file through its relay.",
        );
      const [checkpoint] = await store.listCheckpoints(workspace.principalId, {
        workspaceId: workspace.id,
        state: "ready",
      });
      if (!checkpoint || (checkpoint.expiresAt && checkpoint.expiresAt <= new Date())) throw notFound();
      const bytes = await persistence.readArtifact(checkpoint, artifact.mount, path, artifact.maxBytes);
      if (!bytes) throw notFound();
      return new Response(bytes, {
        status: 200,
        headers: { "content-type": "application/octet-stream", "cache-control": "no-store" },
      }) as never;
    },
  );
}
