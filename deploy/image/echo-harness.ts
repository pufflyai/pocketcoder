// Harmless echo harness serving AgentAPI's three conversation routes on
// loopback. Used by the fixture-echo template and doctor probes; real
// templates run AgentAPI wrapping a coding-agent CLI instead.

const messages: Array<{ role: string; content: string }> = [];
const status: "stable" | "running" = "stable";

Bun.serve({
	hostname: "127.0.0.1",
	port: Number(process.env.HARNESS_PORT ?? 3284),
	fetch(req) {
		const url = new URL(req.url);
		if (req.method === "GET" && url.pathname === "/status") {
			return Response.json({ status });
		}
		if (req.method === "GET" && url.pathname === "/messages") {
			return Response.json({ messages });
		}
		if (req.method === "POST" && url.pathname === "/message") {
			return req.json().then((body) => {
				const content = String((body as { content?: unknown }).content ?? "");
				messages.push({ role: "user", content });
				messages.push({ role: "agent", content: `echo: ${content}` });
				return Response.json({ ok: true });
			});
		}
		return new Response("not found", { status: 404 });
	},
});

console.log("echo-harness listening");
