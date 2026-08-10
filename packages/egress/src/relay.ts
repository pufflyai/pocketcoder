type RelayData = {
  upstream: WebSocket;
  pending: Array<string | ArrayBuffer | Uint8Array>;
};

export function startControlRelay(upstreamBase: string, port = 18_081) {
  const upstreamUrl = upstreamBase.replace(/^http/, "ws").replace(/\/$/, "");
  const server = Bun.serve<RelayData>({
    hostname: "127.0.0.1",
    port,
    fetch(request, server) {
      const local = new URL(request.url);
      const headers = Object.fromEntries(request.headers.entries());
      const pending: RelayData["pending"] = [];
      const upstream = new WebSocket(`${upstreamUrl}${local.pathname}${local.search}`, {
        headers,
      } as unknown as string[]);
      const accepted = server.upgrade(request, { data: { upstream, pending } });
      if (!accepted) {
        upstream.close();
        return new Response("upgrade required", { status: 426 });
      }
      return undefined;
    },
    websocket: {
      open(socket) {
        socket.data.upstream.addEventListener("open", () => {
          for (const message of socket.data.pending) socket.data.upstream.send(message);
          socket.data.pending.length = 0;
        });
        socket.data.upstream.addEventListener("message", (event) => socket.send(event.data));
        socket.data.upstream.addEventListener("close", (event) =>
          socket.close(event.code, event.reason),
        );
        socket.data.upstream.addEventListener("error", () => socket.close(1011));
      },
      message(socket, message) {
        if (socket.data.upstream.readyState === WebSocket.OPEN) {
          socket.data.upstream.send(message);
        } else {
          socket.data.pending.push(message);
        }
      },
      close(socket) {
        socket.data.upstream.close();
      },
    },
  });
  return { port: server.port, close: () => server.stop(true) };
}
