import type { OpenAPIHono } from "@hono/zod-openapi";
import { ApiError, DisplayOpenRequestSchema, PREVIEW_COOKIE } from "@pstdio/pocketcoder-contracts";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import type { Context } from "hono";
import type { Hub } from "../control-channel/hub";
import { type AppEnv, requireScope } from "../http/middleware";
import type { ViewAdmission } from "../previews/admission";
import { type PreviewSession, PreviewSessions } from "../previews/sessions";
import { previewWebSocket } from "../previews/websocket";
import type { WorkspaceService } from "../workspaces/service";
import { DisplayAdmission } from "./admission";
import { BrowserInput } from "./browser-input";
import { RfbInput } from "./rfb-input";
import { browserPage, browserViewer, desktopPage, license, viewer, viewerCss } from "./viewer";

function sessionCookie(raw: string | undefined) {
  return (
    raw
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${PREVIEW_COOKIE}=`))
      ?.slice(PREVIEW_COOKIE.length + 1) ?? ""
  );
}

const assets = new Map([
  ["/viewer.js", { body: viewer, type: "text/javascript" }],
  ["/browser.js", { body: browserViewer, type: "text/javascript" }],
  ["/viewer.css", { body: viewerCss, type: "text/css" }],
  ["/license", { body: license, type: "text/plain" }],
]);

function isDisplaySocket(path: string, upgrade: string | undefined) {
  return path === "/socket" && upgrade?.toLowerCase() === "websocket";
}

export function composeDisplays(deps: { store: Store; service: WorkspaceService; hub: Hub; views: ViewAdmission }) {
  const sessions = new PreviewSessions(deps.store, deps.service);
  const admission = new DisplayAdmission(deps.views);
  function connect(c: Context<AppEnv>, session: PreviewSession, browserMode: boolean) {
    const url = new URL(c.req.url);
    if (!isDisplaySocket(url.pathname, c.req.header("upgrade"))) return c.notFound();
    if (c.req.header("origin") !== url.origin)
      throw new ApiError("auth.invalid_key", "Display Origin must match exactly.");
    const connection = deps.hub.get(session.workspaceId);
    if (!connection?.registered || connection.protocolVersion < 10)
      throw new ApiError("workspace.disconnected", "Display supervisor is unavailable.");
    const release = admission.reserve(session.workspaceId, session.control === true);
    const input = browserMode ? new BrowserInput(session.control === true) : new RfbInput(session.control === true);
    return previewWebSocket(c, session, sessions, connection, deps.hub, release, (bytes) => input.receive(bytes));
  }
  const browser: import("hono").MiddlewareHandler<AppEnv> = async (c, next) => {
    const url = new URL(c.req.url);
    if (!/^[0-9a-f]{32}-display\.localhost$/.test(url.hostname)) return next();
    if (url.protocol !== "http:") return c.notFound();
    c.header("referrer-policy", "no-referrer");
    c.header("cache-control", "no-store");
    c.header("x-content-type-options", "nosniff");
    c.header(
      "content-security-policy",
      "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    if (url.pathname === "/.pc/open") {
      const { secret, session } = await sessions.exchange(url.searchParams.get("token") ?? "", url.origin);
      c.header(
        "set-cookie",
        `${PREVIEW_COOKIE}=${secret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor((session.expires - Date.now()) / 1000)}`,
      );
      return c.redirect("/", 303);
    }
    const cookie = sessionCookie(c.req.header("cookie"));
    const session = await sessions.lookup(cookie, url.origin);
    const { workspace } = await sessions.authorize(session);
    const browserMode = workspace.templateSnapshot.spec.display?.mode === "browser";
    if (c.req.method !== "GET") throw new ApiError("validation.invalid", "Unsupported display method.");
    if (url.pathname === "/")
      return c.html(browserMode ? browserPage(session.control === true) : desktopPage(session.control === true));
    const asset = assets.get(url.pathname);
    if (asset) return c.body(asset.body, 200, { "content-type": asset.type });
    return connect(c, session, browserMode);
  };
  function register(app: OpenAPIHono<AppEnv>) {
    app.post("/v1/workspaces/:id/display", requireScope("display:view"), async (c) => {
      const parsed = DisplayOpenRequestSchema.safeParse(await c.req.json());
      if (!parsed.success) throw new ApiError("validation.invalid", "Invalid display request.");
      const url = new URL(c.req.url);
      if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
        throw new ApiError("validation.invalid", "Local displays require a loopback controller.");
      const id = c.req.param("id");
      url.hostname = `${id.replaceAll("-", "")}-display.localhost`;
      url.pathname = "/.pc/open";
      url.search = "";
      const minted = await sessions.mint(id, "display", url.origin, c.get("keyId"), parsed.data.control);
      url.searchParams.set("token", minted.token);
      c.header("cache-control", "no-store");
      return c.json({ url: url.href, expires_at: new Date(minted.expires).toISOString() }, 201);
    });
  }
  return { browser, register };
}
