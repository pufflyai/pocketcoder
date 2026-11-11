// A generic HTTP fixture for controller isolation and recovery checks.
// It has no agent context or conversation state.
export function serveControllerProbe(port = 3284) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    maxRequestBodySize: 64 * 1024,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/healthz") return Response.json({ ready: true });
      if (request.method === "POST" && path === "/probe") {
        const body = (await request.json()) as { message?: unknown };
        if (typeof body.message !== "string") return new Response(null, { status: 400 });
        return Response.json({ echo: body.message });
      }
      return new Response(null, { status: 404 });
    },
  });
}
if (import.meta.main) serveControllerProbe();
