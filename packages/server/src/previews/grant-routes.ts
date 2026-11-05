import type { OpenAPIHono } from "@hono/zod-openapi";
import { ApiError } from "@pstdio/pocketcoder-contracts";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import { type AppEnv, requireScope } from "../http/middleware";
import type { WorkspaceService } from "../workspaces/service";
import { PreviewGrants } from "./grants";
import type { PreviewSessions } from "./sessions";

export function registerGrantRoutes(
  app: OpenAPIHono<AppEnv>,
  store: Store,
  service: WorkspaceService,
  sessions: PreviewSessions,
) {
  const grants = new PreviewGrants(store);
  const base = "/v1/workspaces/:id/preview-grants";
  const invalid = () => {
    throw new ApiError("validation.invalid", "Invalid preview grant JSON.");
  };
  app.post(base, requireScope("previews:open"), async (c) => {
    const workspace = await service.getOwned(c.get("principal"), c.req.param("id"));
    const result = await grants.create(workspace, c.get("keyId"), await c.req.json().catch(invalid));
    return c.json(result.grant, result.created ? 201 : 200);
  });
  app.get(`${base}/:grantId`, requireScope("previews:open"), async (c) => {
    const workspace = await service.getOwned(c.get("principal"), c.req.param("id"));
    const grant = await grants.get(workspace, c.get("keyId"), c.req.param("grantId"));
    return c.json({ ...grant, pendingStreams: sessions.pendingStreams(grant.id) });
  });
  app.post(`${base}/:grantId/renew`, requireScope("previews:open"), async (c) => {
    const workspace = await service.getOwned(c.get("principal"), c.req.param("id"));
    return c.json(
      await grants.renew(workspace, c.get("keyId"), c.req.param("grantId"), await c.req.json().catch(invalid)),
    );
  });
  app.post(`${base}/:grantId/revoke`, requireScope("previews:open"), async (c) => {
    const workspace = await service.getOwned(c.get("principal"), c.req.param("id"));
    const grant = await grants.get(workspace, c.get("keyId"), c.req.param("grantId"));
    await store.previewGrants.revoke(grant.id, new Date());
    sessions.closeGrant(grant.id);
    const pendingStreams = sessions.pendingStreams(grant.id);
    return c.json(
      { id: grant.id, state: pendingStreams ? "pending" : "completed", pendingStreams },
      pendingStreams ? 202 : 200,
    );
  });
}
