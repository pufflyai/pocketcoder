interface ProxySocket {
  url: string;
  headers: Record<string, string>;
  upstream: WebSocket | null;
  pending: Array<string | Buffer>;
}

async function interruptUpload(request: Request, port: number, restart?: () => Promise<void>) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Expected a real checkpoint upload body");
  const first = await reader.read();
  if (first.done) throw new Error("Expected nonempty checkpoint upload bytes");
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.set("host", `127.0.0.1:${port}`);
  headers.set("connection", "close");
  const head = `PUT ${url.pathname} HTTP/1.1\r\n${[...headers].map(([key, value]) => `${key}: ${value}\r\n`).join("")}\r\n`;
  await new Promise<void>((resolve, reject) => {
    void Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          socket.write(head);
          socket.write(first.value.subarray(0, 64));
          // Closing a real TCP upload before Content-Length is an interrupted transfer.
          if (restart) {
            void Bun.sleep(100)
              .then(restart)
              .then(() => socket.end())
              .catch(reject);
          } else socket.end();
        },
        data() {},
        close() {
          resolve();
        },
        error(_socket, error) {
          reject(error);
        },
      },
    }).catch(reject);
  });
  await reader.cancel();
  return new Response("Checkpoint upload interrupted by the test connection", { status: 502 });
}

export function createCheckpointInterruptionProxy(port: number, upstreamPort: number) {
  let interrupt = false;
  let restart: (() => Promise<void>) | undefined;
  const server = Bun.serve<ProxySocket>({
    hostname: "0.0.0.0",
    port,
    async fetch(request, server) {
      const url = new URL(request.url);
      const upstream = new URL(`${url.pathname}${url.search}`, `http://127.0.0.1:${upstreamPort}`);
      if (request.headers.get("upgrade") === "websocket") {
        const headers = Object.fromEntries(
          [...request.headers].filter(([key]) => key.startsWith("x-pocketcoder-") || key === "authorization"),
        );
        if (
          server.upgrade(request, {
            data: { url: upstream.href.replace("http:", "ws:"), headers, upstream: null, pending: [] },
          })
        )
          return;
        return new Response(null, { status: 426 });
      }
      if (interrupt && request.method === "PUT" && url.pathname.endsWith("/archive")) {
        interrupt = false;
        const onInterrupted = restart;
        restart = undefined;
        return interruptUpload(request, upstreamPort, onInterrupted);
      }
      return fetch(upstream, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: "manual",
      });
    },
    websocket: {
      open(socket) {
        const upstream = new WebSocket(socket.data.url, { headers: socket.data.headers } as unknown as string[]);
        socket.data.upstream = upstream;
        upstream.onopen = () => {
          for (const message of socket.data.pending) upstream.send(message);
          socket.data.pending.length = 0;
        };
        upstream.onmessage = (event) => socket.send(event.data);
        upstream.onclose = () => socket.close();
        upstream.onerror = () => socket.close();
      },
      message(socket, message) {
        if (socket.data.upstream?.readyState === WebSocket.OPEN) socket.data.upstream.send(message);
        else socket.data.pending.push(message);
      },
      close(socket) {
        socket.data.upstream?.close();
      },
    },
  });
  return {
    interruptNextUpload(onInterrupted?: () => Promise<void>) {
      interrupt = true;
      restart = onInterrupted;
    },
    close: () => server.stop(true),
  };
}
