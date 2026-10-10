import { PREVIEW_FRAME_BYTES, PREVIEW_QUEUE_BYTES, previewRequestHeaders } from "@pstdio/pocketcoder-contracts";

function forwardHeaders(request: Request, preview: URL, cookie: string) {
  const headers = new Headers(request.headers);
  const appCookie = previewRequestHeaders(request.headers).cookie;
  headers.set("host", preview.host);
  headers.set("cookie", appCookie ? `${cookie}; ${appCookie}` : cookie);
  headers.delete("authorization");
  if (headers.has("origin")) headers.set("origin", preview.origin);
  return headers;
}

export async function startPreviewForward(previewUrl: string, port = 0) {
  const preview = new URL(previewUrl);
  if (preview.protocol !== "http:" || !preview.hostname.endsWith(".localhost"))
    throw new Error("Forwarding requires a local preview URL.");
  const destination = new URL(preview);
  destination.hostname = "127.0.0.1";
  const exchanged = await fetch(destination, { redirect: "manual", headers: { host: preview.host } });
  if (exchanged.status !== 303) throw new Error("Could not exchange preview token.");
  const cookie = exchanged.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Missing preview session.");
  type Socket = { upstream: WebSocket; timer: ReturnType<typeof setInterval> };
  const server = Bun.serve<Socket>({
    hostname: "127.0.0.1",
    port,
    maxRequestBodySize: PREVIEW_FRAME_BYTES,
    async fetch(request, server) {
      const url = new URL(request.url);
      const origin = `http://127.0.0.1:${server.port}`;
      if (url.origin !== origin) return new Response("Invalid forwarding host", { status: 403 });
      const websocket = request.headers.get("upgrade")?.toLowerCase() === "websocket";
      if (
        (websocket || !["GET", "HEAD", "OPTIONS"].includes(request.method)) &&
        request.headers.get("origin") !== origin
      ) {
        return new Response("Invalid forwarding Origin", { status: 403 });
      }
      const target = new URL(url.pathname + url.search, destination.origin);
      const headers = forwardHeaders(request, preview, cookie);
      if (!websocket)
        return fetch(target, {
          method: request.method,
          headers,
          body: request.body,
          redirect: "manual",
          signal: request.signal,
        });
      target.protocol = "ws:";
      const protocols =
        headers
          .get("sec-websocket-protocol")
          ?.split(",")
          .map((part) => part.trim()) ?? [];
      const upstream = new WebSocket(target, {
        headers: { host: preview.host, cookie: headers.get("cookie") ?? cookie, origin: preview.origin },
        protocols,
      } as unknown as string[]);
      upstream.binaryType = "arraybuffer";
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            upstream.close();
            reject(new Error("Preview connection timed out"));
          }, 10_000);
          upstream.onopen = () => {
            clearTimeout(timeout);
            resolve();
          };
          upstream.onerror = () => {
            clearTimeout(timeout);
            reject(new Error("Preview connection failed"));
          };
        });
        if (
          server.upgrade(request, {
            data: { upstream, timer: undefined as never },
            headers: new Headers(upstream.protocol ? { "sec-websocket-protocol": upstream.protocol } : {}),
          })
        )
          return;
      } catch {
        upstream.close();
        return new Response("Preview unavailable", { status: 503 });
      }
      upstream.close();
      return new Response("Upgrade failed", { status: 400 });
    },
    websocket: {
      maxPayloadLength: PREVIEW_FRAME_BYTES,
      backpressureLimit: PREVIEW_QUEUE_BYTES,
      closeOnBackpressureLimit: true,
      open(ws) {
        const upstream = ws.data.upstream;
        upstream.onmessage = (event) =>
          ws.send(typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer));
        upstream.onclose = () => ws.close();
        upstream.onerror = () => ws.close();
        ws.data.timer = setInterval(() => {
          if (upstream.bufferedAmount > PREVIEW_QUEUE_BYTES) ws.close();
        }, 10);
        ws.data.timer.unref();
      },
      message(ws, message) {
        ws.data.upstream.send(message);
      },
      close(ws) {
        clearInterval(ws.data.timer);
        ws.data.upstream.close();
      },
    },
  });
  return server;
}
