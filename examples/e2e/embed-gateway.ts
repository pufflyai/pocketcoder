import type { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import type { ServerWebSocket } from "bun";

interface SocketData {
  upstream: WebSocket;
  pending: (string | Uint8Array)[];
  bytes: number;
  downstream?: ServerWebSocket<SocketData>;
}

export function startEmbedGateway(options: {
  port: number;
  key: string;
  cert: string;
  parentOrigin: string;
  apiOrigin: string;
  baseUrl: string;
  client: PocketCoderClient;
  workspaceId: string;
}) {
  const parentPage = `<!doctype html><html><head><meta charset="utf-8"><title>Workspace embedding fixture</title></head><body><a id="open" href="/top" target="_blank" rel="noopener noreferrer">Open in a new tab</a><p id="state">Connecting</p><iframe id="view" width="1280" height="850"></iframe><script>
  const frame=document.getElementById('view'), state=document.getElementById('state');let viewOrigin;
  addEventListener('message',event=>{if(event.source===frame.contentWindow&&event.origin===viewOrigin&&event.data?.type==='pocketcoder.view_unavailable')state.textContent='Cookies blocked: Open in a new tab';});
  fetch('/view?mode=embedded').then(r=>r.json()).then(v=>{viewOrigin=new URL(v.url).origin;frame.src=v.url;state.textContent='Embedded';});
  </script></body></html>`;
  return Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: options.port,
    tls: { key: Bun.file(options.key), cert: Bun.file(options.cert) },
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.origin === options.parentOrigin) {
        if (url.pathname === "/top") {
          const opened = await options.client.displays.open(options.workspaceId, false, {
            session: { mode: "top_level" },
          });
          return Response.redirect(opened.url, 303);
        }
        if (url.pathname !== "/view")
          return new Response(parentPage, {
            headers: { "content-type": "text/html", "referrer-policy": "no-referrer" },
          });
        const session =
          url.searchParams.get("mode") === "top_level"
            ? { mode: "top_level" as const }
            : { mode: "embedded" as const, parentOrigin: options.parentOrigin };
        return Response.json(await options.client.displays.open(options.workspaceId, false, { session }), {
          headers: { "cache-control": "no-store" },
        });
      }
      const headers = new Headers(request.headers);
      headers.set("x-forwarded-host", url.host);
      headers.set("x-forwarded-proto", "https");
      const destination = new URL(url.pathname + url.search, options.baseUrl);
      if (headers.get("upgrade")?.toLowerCase() === "websocket") {
        destination.protocol = "ws:";
        const upstream = new WebSocket(destination, { headers: Object.fromEntries(headers) } as unknown as string[]);
        upstream.binaryType = "arraybuffer";
        const data: SocketData = { upstream, pending: [], bytes: 0 };
        upstream.onmessage = (event) => {
          const value = typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer);
          if (data.downstream) data.downstream.send(value);
          else {
            data.bytes += value.length;
            if (data.bytes > 8 * 1024 * 1024) upstream.close();
            else data.pending.push(value);
          }
        };
        await new Promise<void>((resolve, reject) => {
          upstream.onopen = () => resolve();
          upstream.onerror = () => reject(new Error("View upstream rejected."));
        });
        upstream.onclose = () => data.downstream?.close();
        if (server.upgrade(request, { data })) return;
        upstream.close();
        return new Response("Upgrade failed", { status: 400 });
      }
      return fetch(destination, { method: request.method, headers, body: request.body, redirect: "manual" });
    },
    websocket: {
      open(socket) {
        socket.data.downstream = socket;
        for (const value of socket.data.pending) socket.send(value);
        socket.data.pending = [];
      },
      message(socket, value) {
        socket.data.upstream.send(value);
      },
      close(socket) {
        socket.data.upstream.close();
      },
    },
  });
}
