import { randomUUID } from "node:crypto";
import { ApiError, previewRequestHeaders } from "@pstdio/pocketcoder-contracts";
import type { Server } from "bun";
import type { Context } from "hono";
import { getBunServer } from "hono/bun";
import type { WSEvents } from "hono/ws";
import type { Hub, LiveConnection } from "../control-channel/hub";
import type { AppEnv } from "../http/middleware";
import type { PreviewSession, PreviewSessions } from "./sessions";

export async function previewWebSocket(
  c: Context<AppEnv>,
  session: PreviewSession,
  sessions: PreviewSessions,
  connection: LiveConnection,
  hub: Hub,
  release: () => void,
  input?: (bytes: Uint8Array) => Uint8Array[],
) {
  const url = new URL(c.req.url);
  let id: string | undefined;
  try {
    const protocols = (c.req.header("sec-websocket-protocol") ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (protocols.length > 16 || protocols.some((protocol) => !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/.test(protocol)))
      throw new ApiError("validation.invalid", "Invalid WebSocket protocols.");
    const prepared = await hub.previewSockets.prepare(connection, {
      op: "open",
      request_id: randomUUID(),
      name: session.name,
      path: url.pathname + url.search,
      origin: url.origin,
      cookie: previewRequestHeaders(c.req.raw.headers).cookie,
      protocols,
    });
    id = prepared.id;
    if (prepared.protocol && !protocols.includes(prepared.protocol))
      throw new ApiError("validation.invalid", "Invalid upstream protocol.");
    await sessions.authorize(session);
    let timer: ReturnType<typeof setInterval>;
    const done = () => {
      clearInterval(timer);
      release();
    };
    const events: WSEvents = {
      onOpen: (_event, ws) => {
        hub.previewSockets.attach(prepared.id, ws, done);
        timer = setInterval(() => {
          void sessions.authorize(session).catch(() => hub.previewSockets.close(prepared.id));
        }, 250);
        timer.unref();
      },
      onMessage: (event) => {
        if (input) {
          try {
            if (typeof event.data === "string") throw new Error("Display input must be binary.");
            for (const bytes of input(new Uint8Array(event.data as ArrayBuffer)))
              hub.previewSockets.output(prepared.id, bytes);
          } catch {
            hub.previewSockets.close(prepared.id);
            done();
          }
          return;
        }
        hub.previewSockets.output(
          prepared.id,
          typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer),
        );
      },
      onClose: () => {
        hub.previewSockets.close(prepared.id);
        done();
      },
      onError: () => {
        hub.previewSockets.close(prepared.id);
        done();
      },
    };
    const server = getBunServer<Server<{ events: WSEvents; url: URL; protocol: string }>>(c);
    const upgraded = server?.upgrade(c.req.raw, {
      data: { events, url, protocol: prepared.protocol },
      headers: new Headers(prepared.protocol ? { "sec-websocket-protocol": prepared.protocol } : {}),
    });
    if (!upgraded) throw new ApiError("validation.invalid", "WebSocket upgrade failed.");
    return new Response(null);
  } catch (error) {
    if (id) hub.previewSockets.close(id);
    release();
    throw error;
  }
}
