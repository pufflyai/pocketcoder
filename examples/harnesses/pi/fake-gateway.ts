// Deterministic OpenAI Chat Completions-compatible gateway for the local Pi
// E2E. It proves the real Pi SDK adapter without using credentials or making
// an external model call. Real gateway testing uses PI_GATEWAY_URL instead.

export function startFakePiGateway(): ReturnType<typeof Bun.serve> {
	return Bun.serve({
		hostname: "0.0.0.0",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (request.method === "GET" && url.pathname === "/health") {
				return Response.json({ ok: true });
			}
			if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
				return new Response("not found", { status: 404 });
			}
			const body = (await request.json()) as { model?: string; stream?: boolean };
			const model = body.model ?? "pocketcoder-test";
			const created = Math.floor(Date.now() / 1000);
			if (!body.stream) {
				return Response.json({
					id: "chatcmpl-pocketcoder",
					object: "chat.completion",
					created,
					model,
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: "pocketcoder pi ok" },
							finish_reason: "stop",
						},
					],
					usage: { prompt_tokens: 1, completion_tokens: 4, total_tokens: 5 },
				});
			}
			const chunks = [
				{
					id: "chatcmpl-pocketcoder",
					object: "chat.completion.chunk",
					created,
					model,
					choices: [
						{
							index: 0,
							delta: { role: "assistant", content: "pocketcoder pi ok" },
							finish_reason: null,
						},
					],
				},
				{
					id: "chatcmpl-pocketcoder",
					object: "chat.completion.chunk",
					created,
					model,
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 1, completion_tokens: 4, total_tokens: 5 },
				},
			];
			const payload = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
			return new Response(payload, {
				headers: {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
					connection: "keep-alive",
				},
			});
		},
	});
}
