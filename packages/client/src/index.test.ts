import { describe, expect, test } from "bun:test";
import { PocketCoderClient, PocketCoderError } from "./index";

function fixtureClient(response: () => Response, requests: Request[] = []) {
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const request =
			input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
		requests.push(request);
		return response();
	}) as typeof fetch;
	return new PocketCoderClient(
		{ baseUrl: "http://pocketcoder.test/", apiKey: "pkt_example" },
		fetchImpl,
	);
}

describe("PocketCoderClient", () => {
	test("rejects a malformed successful response instead of returning an empty collection", async () => {
		const client = fixtureClient(() => Response.json({ unexpected: [] }));

		try {
			await client.templates.list();
			throw new Error("expected request to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(PocketCoderError);
			expect((error as PocketCoderError).code).toBe("client.invalid_response");
		}
	});

	test("reports non-JSON failures as a stable client error", async () => {
		const client = fixtureClient(() => new Response("proxy exploded", { status: 502 }));

		try {
			await client.templates.list();
			throw new Error("expected request to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(PocketCoderError);
			expect((error as PocketCoderError).code).toBe("client.non_json_response");
			expect((error as PocketCoderError).status).toBe(502);
		}
	});

	test("preserves API error details and request IDs", async () => {
		const client = fixtureClient(() =>
			Response.json(
				{
					error: {
						code: "auth.missing_scope",
						message: "Missing required scope.",
						request_id: "request-42",
						details: { required: "templates:read" },
					},
				},
				{ status: 403 },
			),
		);

		try {
			await client.templates.list();
			throw new Error("expected request to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(PocketCoderError);
			expect(error).toMatchObject({
				code: "auth.missing_scope",
				status: 403,
				requestId: "request-42",
				details: { required: "templates:read" },
			});
		}
	});

	test("normalizes the base URL and applies authentication to raw requests", async () => {
		const requests: Request[] = [];
		const client = fixtureClient(() => Response.json({ ok: true }), requests);

		const response = await client.raw("/livez");

		expect(response.ok).toBe(true);
		expect(requests[0]?.url).toBe("http://pocketcoder.test/livez");
		expect(requests[0]?.headers.get("authorization")).toBe("Bearer pkt_example");
	});

	test("rejects an invalid base URL at construction time", () => {
		expect(() => new PocketCoderClient({ baseUrl: "not a URL", apiKey: "pkt_example" })).toThrow(
			"valid HTTP(S) URL",
		);
	});

	test("validates checkpoint and operation resources through first-class APIs", async () => {
		const checkpointId = "11111111-1111-4111-8111-111111111111";
		const workspaceId = "22222222-2222-4222-8222-222222222222";
		const client = fixtureClient(() =>
			Response.json({
				id: checkpointId,
				workspace_id: workspaceId,
				state: "ready",
				reason_code: null,
				template: { name: "echo", version: "1", digest: "sha256:echo" },
				manifest_digest: "sha256:manifest",
				logical_bytes: 1,
				stored_bytes: 1,
				file_count: 1,
				mounts: ["work"],
				conversation_restore: "supported",
				label: null,
				created_at: "2026-01-01T00:00:00Z",
				ready_at: "2026-01-01T00:00:00Z",
				expires_at: null,
			}),
		);

		const checkpoint = await client.checkpoints.get(checkpointId);
		expect(checkpoint.state).toBe("ready");
	});

	test("passes a caller abort signal through every resource method", async () => {
		const requests: Request[] = [];
		const client = fixtureClient(() => Response.json({ items: [], next_cursor: null }), requests);
		const controller = new AbortController();

		await client.templates.list({ signal: controller.signal });

		expect(requests[0]?.signal).toBeInstanceOf(AbortSignal);
		controller.abort();
		expect(requests[0]?.signal.aborted).toBe(true);
	});
});
