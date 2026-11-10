import { randomUUID } from "node:crypto";
import { startFakePiGateway } from "../../../../examples/harnesses/pi/fake-gateway";

type Message = { role?: string; content?: string | { type: string; text?: string }[] };

function lastUserPrompt(body: { messages?: Message[] }) {
  const content = body.messages?.findLast((message) => message.role === "user")?.content;
  if (typeof content === "string") return content;
  return (content ?? []).map((part) => part.text ?? "").join("");
}

// Stands in for a deployment's model gateway (agentgateway in reference deployments). It accepts
// only bearers the runtime issuer minted for a live workspace, journals each call by workspace and
// prompt, and can hold a prompt until the test releases it. Answers come from the deterministic
// Pi fixture, so no paid model is involved.
export function startModelGatewayFixture(workspaceOf: (credential: string) => string | null) {
  const innerBearer = randomUUID();
  const inner = startFakePiGateway(innerBearer);
  const calls: { workspaceId: string; prompt: string }[] = [];
  const refused: string[] = [];
  const held = new Map<string, PromiseWithResolvers<void>>();
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health") return Response.json({ ok: true });
      // Lets an egress check prove that following a redirect cannot leave the gateway route.
      if (url.pathname === "/redirect") return Response.redirect(url.searchParams.get("to") ?? "", 302);
      const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      const workspaceId = workspaceOf(bearer.trim());
      if (!workspaceId) {
        refused.push(url.pathname);
        return new Response("unauthorized", { status: 401 });
      }
      const text = await request.text();
      const prompt = lastUserPrompt(JSON.parse(text));
      calls.push({ workspaceId, prompt });
      for (const [marker, gate] of held) if (prompt.includes(marker)) await gate.promise;
      const reply = await fetch(`http://127.0.0.1:${inner.port}${url.pathname}`, {
        method: request.method,
        headers: { authorization: `Bearer ${innerBearer}`, "content-type": "application/json" },
        body: text,
      });
      return new Response(reply.body, { status: reply.status, headers: reply.headers });
    },
  });
  return {
    port: Number(server.port),
    calls,
    refused,
    hold(marker: string) {
      held.set(marker, Promise.withResolvers<void>());
    },
    release(marker: string) {
      held.get(marker)?.resolve();
      held.delete(marker);
    },
    stop() {
      for (const gate of held.values()) gate.resolve();
      server.stop(true);
      inner.stop(true);
    },
  };
}
