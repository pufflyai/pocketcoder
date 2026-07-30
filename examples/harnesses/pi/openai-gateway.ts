export interface OpenAIGatewayConfig {
	apiKey: string;
	clientBearer: string;
	organization?: string;
	project?: string;
	upstreamUrl?: string;
	hostname?: string;
	port?: number;
}

type FetchLike = typeof fetch;

const ALLOWED_PATHS = new Set(["/v1/chat/completions", "/v1/responses"]);

export function createOpenAIGatewayHandler(
	config: OpenAIGatewayConfig,
	fetchImpl: FetchLike = fetch,
): (request: Request) => Promise<Response> {
	const upstreamUrl = (config.upstreamUrl ?? "https://api.openai.com").replace(/\/$/, "");

	return async (request) => {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/health") {
			return Response.json({ ok: true });
		}
		if (request.method !== "POST" || !ALLOWED_PATHS.has(url.pathname)) {
			return new Response("not found", { status: 404 });
		}
		if (request.headers.get("authorization") !== `Bearer ${config.clientBearer}`) {
			return new Response("unauthorized", { status: 401 });
		}

		const headers = new Headers({
			authorization: `Bearer ${config.apiKey}`,
			"content-type": request.headers.get("content-type") ?? "application/json",
		});
		if (config.organization) headers.set("openai-organization", config.organization);
		if (config.project) headers.set("openai-project", config.project);

		const upstream = await fetchImpl(`${upstreamUrl}${url.pathname}`, {
			method: "POST",
			headers,
			body: await request.arrayBuffer(),
			signal: request.signal,
		});
		const responseHeaders = new Headers(upstream.headers);
		for (const name of ["connection", "content-encoding", "content-length", "transfer-encoding"]) {
			responseHeaders.delete(name);
		}
		return new Response(upstream.body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers: responseHeaders,
		});
	};
}

export function startOpenAIGateway(config: OpenAIGatewayConfig): ReturnType<typeof Bun.serve> {
	return Bun.serve({
		hostname: config.hostname ?? "0.0.0.0",
		port: config.port ?? 0,
		fetch: createOpenAIGatewayHandler(config),
	});
}
