import { describe, expect, test } from "bun:test";
import {
	ControlPlaneClient,
	ControlPlaneError,
	ConversationGoneError,
	type WorkspaceSummary,
	WorkspaceTerminalError,
} from "./control-plane";
import { relayTarget, TargetRef, targetFromEnvironment } from "./session-target";

function workspace(overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		external_id: "demo",
		state: "ready",
		agent_state: "stable",
		change_cursor: 3,
		reason_code: null,
		template: { name: "pi-harness", version: "1" },
		failure: null,
		...overrides,
	};
}

function fixtureClient(
	router: (request: Request) => Response | undefined,
	requests: Request[] = [],
): ControlPlaneClient {
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const request =
			input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
		requests.push(request);
		return router(request) ?? new Response("not found", { status: 404 });
	}) as typeof fetch;
	return new ControlPlaneClient(
		{ baseUrl: "http://pocketcoder.test/", key: "pkt_example" },
		fetchImpl,
	);
}

describe("control plane client", () => {
	test("lists workspaces with bearer auth and query filters", async () => {
		const requests: Request[] = [];
		const client = fixtureClient((request) => {
			const url = new URL(request.url);
			if (url.pathname === "/v1/workspaces" && url.searchParams.get("state") === "ready") {
				return Response.json({ items: [workspace()], next_cursor: null });
			}
			return undefined;
		}, requests);

		const items = await client.listWorkspaces({ state: "ready", limit: 20 });
		expect(items).toHaveLength(1);
		expect(items[0]?.external_id).toBe("demo");
		expect(requests[0]?.headers.get("authorization")).toBe("Bearer pkt_example");
		expect(new URL(requests[0]?.url ?? "").searchParams.get("limit")).toBe("20");
	});

	test("creates a workspace with the external id as idempotency key", async () => {
		const requests: Request[] = [];
		const client = fixtureClient((request) => {
			if (request.method === "POST" && new URL(request.url).pathname === "/v1/workspaces") {
				return Response.json(workspace({ state: "queued" }), { status: 201 });
			}
			return undefined;
		}, requests);

		const created = await client.createWorkspace({
			externalId: "pi-1",
			templateName: "pi-harness",
		});
		expect(created.state).toBe("queued");
		expect(requests[0]?.headers.get("idempotency-key")).toBe("pi-1");
		expect(await requests[0]?.json()).toEqual({
			external_id: "pi-1",
			template: { name: "pi-harness" },
		});
	});

	test("pages the conversation and surfaces the next cursor", async () => {
		const client = fixtureClient((request) => {
			const url = new URL(request.url);
			if (url.pathname.endsWith("/conversation")) {
				const after = Number(url.searchParams.get("after"));
				if (after === 0) {
					return Response.json({
						items: [
							{
								message_id: "m1",
								seq: 1,
								role: "user",
								content: "hi",
								occurred_at: "2026-01-01T00:00:00Z",
								metadata: {},
							},
						],
						next_cursor: 1,
						retention: { status: "retained", expires_at: null },
					});
				}
				return Response.json({
					items: [],
					next_cursor: null,
					retention: { status: "retained", expires_at: null },
				});
			}
			return undefined;
		});

		const first = await client.readConversationPage("ws", 0, 200);
		expect(first.items).toHaveLength(1);
		expect(first.nextCursor).toBe(1);
		const second = await client.readConversationPage("ws", 1, 200);
		expect(second.items).toHaveLength(0);
		expect(second.nextCursor).toBeNull();
	});

	test("maps 410 conversation errors to ConversationGoneError", async () => {
		const client = fixtureClient((request) => {
			if (new URL(request.url).pathname.endsWith("/conversation")) {
				return Response.json(
					{ error: { code: "conversation.expired", message: "gone", request_id: "r1" } },
					{ status: 410 },
				);
			}
			return undefined;
		});

		expect(client.readConversationPage("ws", 0, 200)).rejects.toBeInstanceOf(ConversationGoneError);
	});

	test("surfaces error codes on other failures", async () => {
		const client = fixtureClient(() =>
			Response.json(
				{ error: { code: "auth.forbidden", message: "no scope", request_id: "r2" } },
				{ status: 403 },
			),
		);

		try {
			await client.listTemplates();
			throw new Error("expected failure");
		} catch (error) {
			expect(error).toBeInstanceOf(ControlPlaneError);
			expect((error as ControlPlaneError).code).toBe("auth.forbidden");
			expect((error as ControlPlaneError).status).toBe(403);
		}
	});

	test("waitForReady follows the change cursor until ready", async () => {
		const states = ["provisioning", "connected", "ready"];
		let calls = 0;
		const client = fixtureClient((request) => {
			const url = new URL(request.url);
			if (url.pathname.endsWith("/changes")) {
				const state = states[Math.min(calls, states.length - 1)] ?? "ready";
				calls += 1;
				return Response.json({
					cursor: calls,
					changed: true,
					workspace: workspace({ state, change_cursor: calls }),
				});
			}
			return undefined;
		});

		const seen: string[] = [];
		const ready = await client.waitForReady(
			workspace({ state: "queued", change_cursor: 0 }),
			5_000,
			{
				onTick: (w) => seen.push(w.state),
			},
		);
		expect(ready.state).toBe("ready");
		expect(seen).toEqual(["provisioning", "connected", "ready"]);
	});

	test("waitForReady throws WorkspaceTerminalError with the failure log", async () => {
		const client = fixtureClient((request) => {
			if (new URL(request.url).pathname.endsWith("/changes")) {
				return Response.json({
					cursor: 1,
					changed: true,
					workspace: workspace({
						state: "failed",
						reason_code: "launch_failed",
						failure: { reason_code: "launch_failed", log_tail: "boom" },
					}),
				});
			}
			return undefined;
		});

		try {
			await client.waitForReady(workspace({ state: "queued", change_cursor: 0 }), 5_000);
			throw new Error("expected failure");
		} catch (error) {
			expect(error).toBeInstanceOf(WorkspaceTerminalError);
			expect((error as WorkspaceTerminalError).message).toContain("launch_failed");
			expect((error as WorkspaceTerminalError).message).toContain("boom");
		}
	});
});

describe("session target", () => {
	test("resolves a relay target from the environment", () => {
		const target = targetFromEnvironment({
			POCKETCODER_URL: "http://localhost:7080/",
			POCKETCODER_KEY: "pkt_example",
			POCKETCODER_WORKSPACE_ID: "workspace id",
		});
		expect(target).toEqual(relayTarget("http://localhost:7080", "pkt_example", "workspace id"));
		expect(target.mode === "relay" && target.serviceUrl).toBe(
			"http://localhost:7080/v1/workspaces/workspace%20id/services/agent",
		);
	});

	test("resolves unset and direct targets", () => {
		expect(targetFromEnvironment({ POCKETCODER_KEY: "pkt_example" })).toEqual({
			mode: "unset",
			baseUrl: "http://127.0.0.1:7080",
			key: "pkt_example",
		});
		expect(
			targetFromEnvironment({
				POCKETCODER_KEY: "pkt_example",
				POCKETCODER_AGENTAPI_URL: "http://agentapi.test/",
			}),
		).toEqual({ mode: "direct", key: "pkt_example", serviceUrl: "http://agentapi.test" });
		expect(() => targetFromEnvironment({})).toThrow("POCKETCODER_KEY is required");
	});

	test("notifies listeners on target switch", () => {
		const ref = new TargetRef(targetFromEnvironment({ POCKETCODER_KEY: "pkt_example" }));
		const seen: string[] = [];
		ref.onChange((target) => seen.push(target.mode));
		ref.set(relayTarget("http://localhost:7080", "pkt_example", "ws-2"));
		expect(ref.current.mode).toBe("relay");
		expect(seen).toEqual(["relay"]);
	});
});
