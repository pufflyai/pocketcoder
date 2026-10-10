import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  ApiError,
  PREVIEW_MIN_PROTOCOL_VERSION,
  PreviewNameSchema,
  PreviewOpenRequestSchema,
} from "@pstdio/pocketcoder-contracts";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import type { Hub } from "../control-channel/hub";
import { type AppEnv, requireScope } from "../http/middleware";
import type { WorkspaceService } from "../workspaces/service";
import type { ViewAdmission } from "./admission";
import { previewHttp } from "./http";
import { PreviewSessions } from "./sessions";
import { viewExchange } from "./view-exchange";
import type { ViewPolicy } from "./view-policy";
import { previewWebSocket } from "./websocket";

export function composePreviews(deps: {
  store: Store;
  service: WorkspaceService;
  hub: Hub;
  views: ViewAdmission;
  policy: ViewPolicy;
}) {
  const sessions = new PreviewSessions(deps.store, deps.service);

  const browser: import("hono").MiddlewareHandler<AppEnv> = async (c, next) => {
    const url = deps.policy.requestUrl(c);
    const host = deps.policy.host(url);
    if (!host) return next();
    if ("invalid" in host || !PreviewNameSchema.safeParse(host.name).success) return c.notFound();
    c.header("referrer-policy", "no-referrer");
    c.header("cache-control", "no-store");
    const exchanged = await viewExchange(c, url, deps.policy, sessions);
    if (exchanged) return exchanged;
    const session = await sessions.lookup(deps.policy.secret(c.req.header("cookie"), url), url.origin);
    const websocket = validatePreviewRequest(c.req.raw, url);
    const connection = deps.hub.get(session.workspaceId);
    if (!connection?.registered) throw new ApiError("workspace.disconnected", "Workspace supervisor is unavailable.");
    if (connection.protocolVersion < PREVIEW_MIN_PROTOCOL_VERSION)
      throw new ApiError("relay.streaming_unsupported", "Previews require supervisor protocol v10.");
    const release = deps.views.reserve(session.workspaceId, session.name);
    if (!websocket) {
      try {
        return await previewHttp(c.req.raw, session, sessions, deps.hub, release, deps.policy.framing(session));
      } catch (error) {
        release();
        throw error;
      }
    }
    return previewWebSocket(c, session, sessions, connection, deps.hub, release);
  };

  function register(app: OpenAPIHono<AppEnv>) {
    app.get("/v1/workspaces/:id/previews", requireScope("previews:open"), async (c) => {
      const workspace = await deps.service.getOwned(c.get("principal"), c.req.param("id"));
      return c.json(
        Object.entries(workspace.templateSnapshot.spec.previews ?? {}).map(([name, preview]) => ({
          name,
          port: preview.port,
        })),
      );
    });
    app.post("/v1/workspaces/:id/previews/:name", requireScope("previews:open"), async (c) => {
      const name = PreviewNameSchema.safeParse(c.req.param("name"));
      if (!name.success) throw new ApiError("validation.invalid", "Invalid preview name.");
      const id = c.req.param("id");
      const body = await c.req.text();
      let input: unknown = {};
      try {
        if (body) input = JSON.parse(body);
      } catch {
        throw new ApiError("validation.invalid", "Invalid preview request JSON.");
      }
      const parsed = PreviewOpenRequestSchema.safeParse(input);
      if (!parsed.success) throw new ApiError("validation.invalid", "Invalid preview request.");
      const url = deps.policy.mintUrl(deps.policy.requestUrl(c), id, name.data, parsed.data.session);
      const minted = await sessions.mint(id, name.data, url.origin, c.get("keyId"), false, parsed.data.session);
      url.searchParams.set("token", minted.token);
      c.header("cache-control", "no-store");
      return c.json({ url: url.href, expires_at: new Date(minted.expires).toISOString() }, 201);
    });
  }
  return { browser, register };
}

function validatePreviewRequest(request: Request, url: URL) {
  const websocket = request.headers.get("upgrade")?.toLowerCase() === "websocket";
  if (
    (websocket || !["GET", "HEAD", "OPTIONS"].includes(request.method)) &&
    request.headers.get("origin") !== url.origin
  ) {
    throw new ApiError("auth.invalid_key", "Preview Origin must match exactly.");
  }
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(request.method))
    throw new ApiError("validation.invalid", "Unsupported preview method.");

  return websocket;
}
