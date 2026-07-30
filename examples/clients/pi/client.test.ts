import { describe, expect, test } from "bun:test";
import { RemoteAgentClient, serviceUrlFromEnvironment } from "./client";

describe("local Pi AgentAPI client", () => {
	test("sends a turn and waits for the new remote agent response", async () => {
		let status = "stable";
		const messages = [{ id: 0, role: "agent", content: "remote ready" }];
		const requests: Request[] = [];
		const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
			const request =
				input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
			requests.push(request);
			const path = new URL(request.url).pathname;
			if (request.method === "GET" && path.endsWith("/messages")) {
				return Response.json({ messages });
			}
			if (request.method === "GET" && path.endsWith("/status")) {
				if (status === "running") {
					status = "stable";
					messages.push({ id: 2, role: "agent", content: "fixture contents" });
				}
				return Response.json({ status });
			}
			if (request.method === "POST" && path.endsWith("/message")) {
				status = "running";
				messages.push({ id: 1, role: "user", content: "read the file" });
				return Response.json({ ok: true });
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;
		const client = new RemoteAgentClient(
			{
				serviceUrl: "http://pocketcoder.test/v1/workspaces/ws/services/agent",
				key: "pkt_example",
				pollIntervalMs: 1,
				timeoutMs: 100,
			},
			fetchImpl,
		);

		expect(await client.send("read the file")).toBe("fixture contents");
		expect(await requests.at(-1)?.headers.get("authorization")).toBe("Bearer pkt_example");
	});

	test("derives the relay URL from the workspace", () => {
		expect(
			serviceUrlFromEnvironment({
				POCKETCODER_URL: "http://localhost:7080/",
				POCKETCODER_KEY: "pkt_example",
				POCKETCODER_WORKSPACE_ID: "workspace id",
			}),
		).toEqual({
			serviceUrl: "http://localhost:7080/v1/workspaces/workspace%20id/services/agent",
			key: "pkt_example",
		});
	});
});
