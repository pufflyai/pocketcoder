import { ApiError, PREVIEW_COOKIE, type ViewSessionOptions } from "@pstdio/pocketcoder-contracts";
import type { Context } from "hono";
import type { PublicViewConfig } from "../config/public-views";
import type { PreviewSession } from "./sessions";

const PUBLIC_COOKIE = "__Host-pc-view";
export class ViewPolicy {
  constructor(private readonly config?: PublicViewConfig) {}

  requestUrl(c: Context) {
    const url = new URL(c.req.url);
    const peer = c.env?.requestIP?.(c.req.raw)?.address;
    if (peer && this.config?.trustedIngress.includes(peer)) {
      const host = c.req.header("x-forwarded-host");
      const proto = c.req.header("x-forwarded-proto");
      if (host || proto) {
        if (proto !== "https" || !host || !/^[a-z0-9.-]+(?::[0-9]+)?$/.test(host))
          throw new ApiError("validation.invalid", "Invalid ingress origin.");
        const publicUrl = new URL(`https://${host}`);
        url.protocol = publicUrl.protocol;
        url.hostname = publicUrl.hostname;
        url.port = publicUrl.port;
      }
    }
    return url;
  }

  host(url: URL) {
    let label: string;
    if (url.hostname.endsWith(".localhost")) {
      if (url.protocol !== "http:") return { invalid: true } as const;
      label = url.hostname.slice(0, -".localhost".length);
    } else {
      if (!this.config) return undefined;
      const origin = new URL(this.config.origin);
      if (url.hostname !== origin.hostname && !url.hostname.endsWith(`.${origin.hostname}`)) return undefined;
      if (url.protocol !== "https:" || url.port !== origin.port) return { invalid: true } as const;
      label = url.hostname.slice(0, -(origin.hostname.length + 1));
    }
    const match = label.match(/^[0-9a-f]{32}-([a-z][a-z0-9-]{0,19})$/);
    return match?.[1] ? { name: match[1] } : ({ invalid: true } as const);
  }

  mintUrl(request: URL, workspaceId: string, name: string, session: ViewSessionOptions) {
    const url = new URL(request);
    if (session.mode === "local") {
      if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
        throw new ApiError("validation.invalid", "Local views require a loopback HTTP controller.");
      url.hostname = `${workspaceId.replaceAll("-", "")}-${name}.localhost`;
    } else {
      if (!this.config || request.origin !== this.config.apiOrigin)
        throw new ApiError("validation.invalid", "HTTPS views require the configured API origin.");
      if (session.mode === "embedded" && !this.config.parents.includes(session.parentOrigin))
        throw new ApiError("validation.invalid", "Embedded parent origin is not allowed.");
      const publicUrl = new URL(this.config.origin);
      url.protocol = publicUrl.protocol;
      url.hostname = `${workspaceId.replaceAll("-", "")}-${name}.${publicUrl.hostname}`;
      url.port = publicUrl.port;
    }
    url.pathname = "/.pc/open";
    url.search = "";
    return url;
  }

  cookie(secret: string, session: PreviewSession) {
    const name = session.mode === "local" ? PREVIEW_COOKIE : PUBLIC_COOKIE;
    let attributes = "SameSite=Lax";
    if (session.mode === "embedded") attributes = "Secure; SameSite=None; Partitioned";
    if (session.mode === "top_level") attributes = "Secure; SameSite=Lax";
    return `${name}=${secret}; Path=/; HttpOnly; ${attributes}; Max-Age=${Math.max(0, Math.floor((session.expires - Date.now()) / 1000))}`;
  }

  secret(raw: string | undefined, url: URL) {
    const name = url.protocol === "https:" ? PUBLIC_COOKIE : PREVIEW_COOKIE;
    return (
      raw
        ?.split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${name}=`))
        ?.slice(name.length + 1) ?? ""
    );
  }

  framing(session: PreviewSession) {
    return session.mode === "embedded" ? `frame-ancestors 'self' ${session.parentOrigin}` : "frame-ancestors 'none'";
  }
}
