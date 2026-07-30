// A loopback fake of AgentAPI's three routes, used by supervisor and relay
// tests without a real coding agent.

export interface FakeAgentApi {
	url: string;
	port: number;
	messages: Array<{ role: string; content: string }>;
	setStatus(status: "stable" | "running"): void;
	stop(): void;
}

export function startFakeAgentApi(port = 0): FakeAgentApi {
	let status: "stable" | "running" = "stable";
	const messages: Array<{ role: string; content: string }> = [];

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port,
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
					const content = (body as { content?: string }).content ?? "";
					messages.push({ role: "user", content });
					status = "running";
					queueMicrotask(() => {
						messages.push({ role: "agent", content: `echo: ${content}` });
						status = "stable";
					});
					return Response.json({ ok: true });
				});
			}
			return new Response("not found", { status: 404 });
		},
	});

	return {
		url: `http://127.0.0.1:${server.port}`,
		port: Number(server.port),
		messages,
		setStatus(next) {
			status = next;
		},
		stop() {
			server.stop(true);
		},
	};
}
