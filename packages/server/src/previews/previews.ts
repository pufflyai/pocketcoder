import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  ApiError,
  PREVIEW_COOKIE,
  PREVIEW_MIN_PROTOCOL_VERSION,
  PreviewNameSchema,
} from "@pstdio/pocketcoder-contracts";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import type { Hub } from "../control-channel/hub";
import { type AppEnv, requireScope } from "../http/middleware";
import type { WorkspaceService } from "../workspaces/service";
import type { ViewAdmission } from "./admission";
import { previewHttp } from "./http";
import { PreviewSessions } from "./sessions";
import { previewWebSocket } from "./websocket";

function localApiOrigin(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new ApiError("validation.invalid", "Local previews require a loopback HTTP controller.");
  }
  return url;
}

export function composePreviews(deps: { store: Store; service: WorkspaceService; hub: Hub; views: ViewAdmission }) {
  const sessions = new PreviewSessions(deps.store, deps.service);

  const browser: import("hono").MiddlewareHandler<AppEnv> = async (c, next) => {
    const url = new URL(c.req.url);
    if (!url.hostname.endsWith(".localhost")) return next();
    // This listener is local-only. Forwarded host headers never choose a destination.
    if (url.protocol !== "http:" || !/^[0-9a-f]{32}-[a-z][a-z0-9-]{0,19}\.localhost$/.test(url.hostname))
      return c.notFound();
    c.header("referrer-policy", "no-referrer");
    c.header("cache-control", "no-store");
    if (url.pathname === "/.pc/open") {
      const token = url.searchParams.get("token") ?? "";
      const { secret, session } = await sessions.exchange(token, url.origin);
      c.header(
        "set-cookie",
        `${PREVIEW_COOKIE}=${secret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor((session.expires - Date.now()) / 1000)}`,
      );
      return c.redirect("/", 303);
    }
    const cookie =
      c.req
        .header("cookie")
        ?.split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${PREVIEW_COOKIE}=`))
        ?.slice(PREVIEW_COOKIE.length + 1) ?? "";
    const session = await sessions.lookup(cookie, url.origin);
    const websocket = validatePreviewRequest(c.req.raw, url);
    const connection = deps.hub.get(session.workspaceId);
    if (!connection?.registered) throw new ApiError("workspace.disconnected", "Workspace supervisor is unavailable.");
    if (connection.protocolVersion < PREVIEW_MIN_PROTOCOL_VERSION)
      throw new ApiError("relay.streaming_unsupported", "Previews require supervisor protocol v10.");
    const release = deps.views.reserve(session.workspaceId, session.name);
    if (!websocket) {
      try {
        return await previewHttp(c.req.raw, session, sessions, deps.hub, release);
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
      const url = localApiOrigin(c.req.url);
      url.hostname = `${id.replaceAll("-", "")}-${name.data}.localhost`;
      url.pathname = "/.pc/open";
      url.search = "";
      const minted = await sessions.mint(id, name.data, url.origin, c.get("keyId"));
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
