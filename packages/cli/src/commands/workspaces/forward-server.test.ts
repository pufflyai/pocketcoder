import { expect, test } from "bun:test";
import { startPreviewForward } from "./forward-server";

test("loopback forwarding preserves app cookies for HTTP and WebSockets and rejects foreign hosts and origins", async () => {
  const backend = Bun.serve<{ cookie: string }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname === "/.pc/open")
        return new Response(null, {
          status: 303,
          headers: { "set-cookie": "pc-preview-session=bound; HttpOnly; Path=/", location: "/" },
        });
      if (server.upgrade(request, { data: { cookie: request.headers.get("cookie") ?? "" } })) return;
      return Response.json({
        cookie: request.headers.get("cookie"),
        authorization: request.headers.get("authorization"),
      });
    },
    websocket: {
      message(socket) {
        socket.send(socket.data.cookie);
      },
    },
  });
  const forward = await startPreviewForward(
    `http://${"a".repeat(32)}-web.localhost:${backend.port}/.pc/open?token=once`,
  );
  const base = `http://127.0.0.1:${forward.port}`;
  let socket: WebSocket | undefined;
  try {
    const response = await fetch(base, { headers: { cookie: "app-session=allowed", authorization: "secret" } });
    expect(await response.json()).toEqual({
      cookie: "pc-preview-session=bound; app-session=allowed",
      authorization: null,
    });
    expect((await fetch(base, { headers: { host: "foreign.test" } })).status).toBe(403);
    expect((await fetch(base, { method: "POST", headers: { origin: "http://foreign.test" } })).status).toBe(403);
    const live = new WebSocket(base.replace("http", "ws"), {
      headers: { cookie: "app-session=allowed", origin: base },
    } as unknown as string[]);
    socket = live;
    await new Promise<void>((resolve, reject) => {
      live.onopen = () => resolve();
      live.onerror = () => reject(new Error("socket failed"));
    });
    const received = new Promise<string>((resolve) => {
      live.onmessage = (event) => resolve(String(event.data));
    });
    live.send("cookie");
    expect(await received).toBe("pc-preview-session=bound; app-session=allowed");
  } finally {
    socket?.close();
    await forward.stop(true);
    await backend.stop(true);
  }
});
