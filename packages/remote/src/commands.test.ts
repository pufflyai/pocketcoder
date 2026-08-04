import { describe, expect, test } from "bun:test";
import {
	type CommandContext,
	type CommandUi,
	registerWorkspaceCommands,
	type WorkspaceCommandDeps,
} from "./commands";
import { ControlPlaneClient } from "./control-plane";
import { relayTarget, TargetRef } from "./session-target";
import { StatusPoller, statusText } from "./status";

const WS_A = "aaaaaaaa-1111-4111-8111-111111111111";
const WS_B = "bbbbbbbb-2222-4222-8222-222222222222";

function workspaceResource(id: string, state = "ready", changeCursor = 0) {
	return {
		id,
		external_id: `ext-${id.slice(0, 4)}`,
		state,
		agent_state: "stable",
		change_cursor: changeCursor,
		reason_code: state === "failed" ? "launch_failed" : null,
		template: { name: "pi-harness", version: "1", digest: "sha256:template" },
		provider_kind: "docker",
		provisioning_mode: "cold",
		network: { state: "ready" },
		health: {},
		created_at: "2026-01-01T00:00:00Z",
		updated_at: "2026-01-01T00:00:00Z",
		connected_at: "2026-01-01T00:00:00Z",
		ready_at: state === "ready" ? "2026-01-01T00:00:00Z" : null,
		deadline_at: "2026-01-01T01:00:00Z",
		terminal_at: state === "failed" ? "2026-01-01T00:01:00Z" : null,
		metadata: {},
		origin_workspace_id: null,
		restored_from_checkpoint_id: null,
		source: null,
		persistence: {
			enabled: false,
			conversation_restore: "filesystem_only",
			conversation_resume: { status: "unsupported", reason: "filesystem_only" },
			latest_checkpoint_id: null,
		},
		outputs: {},
		failure:
			state === "failed"
				? {
						reason_code: "launch_failed",
						log_tail: "boom",
						log_tail_truncated: false,
						last_log_seq: 1,
					}
				: null,
	};
}

interface Recorded {
	notifications: Array<{ message: string; type?: string }>;
	working: Array<string | undefined>;
	requests: Request[];
	newSessions: number;
}

function commandHarness(options: {
	router: (request: Request, recorded: Recorded) => Response | undefined;
	answers?: { select?: string | undefined; confirm?: boolean; input?: string | undefined };
	initialTarget?: Parameters<TargetRef["set"]>[0];
	waitTimeoutMs?: number;
}) {
	const recorded: Recorded = { notifications: [], working: [], requests: [], newSessions: 0 };
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const request =
			input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
		recorded.requests.push(request);
		return options.router(request, recorded) ?? new Response("not found", { status: 404 });
	}) as typeof fetch;
	const controlPlane = new ControlPlaneClient(
		{ baseUrl: "http://pocketcoder.test", key: "pkt_example" },
		fetchImpl,
	);
	const targets = new TargetRef(
		options.initialTarget ?? {
			mode: "unset",
			baseUrl: "http://pocketcoder.test",
			key: "pkt_example",
		},
	);
	const handlers = new Map<string, (args: string, ctx: CommandContext) => Promise<void>>();
	const registrar = {
		registerCommand(
			name: string,
			config: { handler: (args: string, ctx: CommandContext) => Promise<void> },
		) {
			handlers.set(name, config.handler);
		},
	};
	const deps: WorkspaceCommandDeps = {
		targets,
		controlPlane,
		waitTimeoutMs: options.waitTimeoutMs ?? 5_000,
	};
	registerWorkspaceCommands(registrar, deps);
	const ui: CommandUi = {
		select: async () => options.answers?.select,
		confirm: async () => options.answers?.confirm ?? false,
		input: async () => options.answers?.input,
		notify: (message, type) => recorded.notifications.push({ message, type }),
		setWorkingMessage: (message) => recorded.working.push(message),
	};
	const ctx: CommandContext = {
		hasUI: true,
		ui,
		newSession: async () => {
			recorded.newSessions += 1;
			return { cancelled: false };
		},
	};
	return { recorded, targets, handlers, ctx };
}

describe("workspace commands", () => {
	test("/workspace switches the target and starts a new session", async () => {
		const { recorded, targets, handlers, ctx } = commandHarness({
			router: (request) => {
				const url = new URL(request.url);
				if (url.pathname === "/v1/workspaces" && url.searchParams.get("state") === "ready") {
					return Response.json({
						items: [workspaceResource(WS_A), workspaceResource(WS_B)],
						next_cursor: null,
					});
				}
				return undefined;
			},
			answers: { select: `ext-bbbb · pi-harness · ${WS_B.slice(0, 8)}` },
		});

		await handlers.get("workspace")?.("", ctx);

		expect(targets.current).toEqual(relayTarget("http://pocketcoder.test", "pkt_example", WS_B));
		expect(recorded.newSessions).toBe(1);
		expect(recorded.notifications).toEqual([]);
	});

	test("/workspace leaves the target alone when the picker is dismissed", async () => {
		const { recorded, targets, handlers, ctx } = commandHarness({
			router: (request) => {
				if (new URL(request.url).pathname === "/v1/workspaces") {
					return Response.json({ items: [workspaceResource(WS_A)], next_cursor: null });
				}
				return undefined;
			},
			answers: { select: undefined },
		});

		await handlers.get("workspace")?.("", ctx);

		expect(targets.current.mode).toBe("unset");
		expect(recorded.newSessions).toBe(0);
	});

	test("/workspace-create creates with the typed external id and waits for ready", async () => {
		const { recorded, targets, handlers, ctx } = commandHarness({
			router: (request) => {
				const url = new URL(request.url);
				if (url.pathname === "/v1/templates") {
					return Response.json({
						items: [
							{ name: "pi-harness", version: "1", digest: "sha256:template", status: "active" },
						],
						next_cursor: null,
					});
				}
				if (request.method === "POST" && url.pathname === "/v1/workspaces") {
					return Response.json(workspaceResource(WS_A, "queued"), { status: 201 });
				}
				if (url.pathname.endsWith("/changes")) {
					return Response.json({
						cursor: 1,
						changed: true,
						workspace: workspaceResource(WS_A, "ready", 1),
					});
				}
				return undefined;
			},
			answers: { select: "pi-harness@1", input: "my-workspace" },
		});

		await handlers.get("workspace-create")?.("", ctx);

		const create = recorded.requests.find((request) => request.method === "POST");
		expect(create?.headers.get("idempotency-key")).toBe("my-workspace");
		expect(targets.current).toEqual(relayTarget("http://pocketcoder.test", "pkt_example", WS_A));
		expect(recorded.newSessions).toBe(1);
		expect(recorded.working.at(-1)).toBeUndefined();
	});

	test("/workspace-create surfaces terminal launch failures", async () => {
		const { recorded, targets, handlers, ctx } = commandHarness({
			router: (request) => {
				const url = new URL(request.url);
				if (url.pathname === "/v1/templates") {
					return Response.json({
						items: [
							{ name: "pi-harness", version: "1", digest: "sha256:template", status: "active" },
						],
						next_cursor: null,
					});
				}
				if (request.method === "POST" && url.pathname === "/v1/workspaces") {
					return Response.json(workspaceResource(WS_A, "queued"), { status: 201 });
				}
				if (url.pathname.endsWith("/changes")) {
					return Response.json({
						cursor: 1,
						changed: true,
						workspace: workspaceResource(WS_A, "failed", 1),
					});
				}
				return undefined;
			},
			answers: { select: "pi-harness@1", input: "my-workspace" },
		});

		await handlers.get("workspace-create")?.("", ctx);

		expect(targets.current.mode).toBe("unset");
		expect(recorded.newSessions).toBe(0);
		expect(recorded.notifications[0]?.type).toBe("error");
		expect(recorded.notifications[0]?.message).toContain("launch_failed");
		expect(recorded.notifications[0]?.message).toContain("boom");
	});

	test("/workspace-cancel cancels only after confirmation", async () => {
		const attached = relayTarget("http://pocketcoder.test", "pkt_example", WS_A);
		const declined = commandHarness({
			router: () => undefined,
			answers: { confirm: false },
			initialTarget: attached,
		});
		await declined.handlers.get("workspace-cancel")?.("", declined.ctx);
		expect(declined.recorded.requests).toHaveLength(0);

		const confirmed = commandHarness({
			router: (request) => {
				if (request.method === "POST" && new URL(request.url).pathname.endsWith("/cancel")) {
					return Response.json(workspaceResource(WS_A, "canceled"));
				}
				return undefined;
			},
			answers: { confirm: true },
			initialTarget: attached,
		});
		await confirmed.handlers.get("workspace-cancel")?.("", confirmed.ctx);
		expect(confirmed.recorded.requests).toHaveLength(1);
		expect(confirmed.recorded.notifications[0]?.message).toContain("canceled");
	});

	test("commands refuse to run against a direct AgentAPI target", async () => {
		const { recorded, handlers, ctx } = commandHarness({
			router: () => undefined,
			initialTarget: { mode: "direct", key: "pkt_example", serviceUrl: "http://agentapi.test" },
		});

		await handlers.get("workspace")?.("", ctx);

		expect(recorded.requests).toHaveLength(0);
		expect(recorded.notifications[0]?.type).toBe("warning");
	});
});

describe("status poller", () => {
	function pollerHarness(states: Array<{ state: string; agentState?: string; fail?: boolean }>) {
		let call = 0;
		const delays: number[] = [];
		const statuses: Array<string | undefined> = [];
		const notifications: string[] = [];
		const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
			const request =
				input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
			const step = states[Math.min(call, states.length - 1)];
			call += 1;
			if (!step || !new URL(request.url).pathname.endsWith("/changes")) {
				return new Response("not found", { status: 404 });
			}
			if (step.fail) {
				return new Response("boom", { status: 500, headers: { "retry-after": "0" } });
			}
			return Response.json({
				cursor: call,
				changed: true,
				workspace: workspaceResource(WS_A, step.state, call),
			});
		}) as typeof fetch;
		const controlPlane = new ControlPlaneClient(
			{ baseUrl: "http://pocketcoder.test", key: "pkt_example" },
			fetchImpl,
		);
		const poller = new StatusPoller(
			controlPlane,
			{ id: WS_A, change_cursor: 0 },
			{
				setStatus: (_key, text) => statuses.push(text),
				notify: (message) => notifications.push(message),
			},
			{
				delay: async (ms) => {
					delays.push(ms);
				},
			},
		);
		return { poller, delays, statuses, notifications, requestCount: () => call };
	}

	async function until(predicate: () => boolean): Promise<void> {
		for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) {
			await Bun.sleep(1);
		}
		expect(predicate()).toBe(true);
	}

	test("tracks workspace state and stops on a terminal transition", async () => {
		const { poller, statuses, notifications } = pollerHarness([
			{ state: "ready" },
			{ state: "canceled" },
		]);

		poller.start();
		await until(() => notifications.length === 1);
		expect(statuses).toContain(statusText({ id: WS_A, state: "ready", agent_state: "stable" }));
		expect(notifications[0]).toContain("canceled");
		await poller.stop();
		expect(statuses.at(-1)).toBeUndefined();
	});

	test("backs off and reports reconnecting on errors", async () => {
		const { poller, delays, statuses, notifications } = pollerHarness([
			{ fail: true, state: "ready" },
			{ fail: true, state: "ready" },
			{ fail: true, state: "ready" },
			{ fail: true, state: "ready" },
			{ fail: true, state: "ready" },
			{ fail: true, state: "ready" },
			{ state: "canceled" },
		]);

		poller.start();
		await until(() => notifications.length === 1);
		expect(delays.slice(0, 2)).toEqual([1_000, 2_000]);
		expect(statuses.some((status) => status?.includes("reconnecting"))).toBe(true);
		await poller.stop();
	});

	test("does not poll while paused and resumes on demand", async () => {
		const harness = pollerHarness([{ state: "canceled" }]);
		harness.poller.pause();
		harness.poller.start();
		await Bun.sleep(10);
		expect(harness.requestCount()).toBe(0);

		harness.poller.resume();
		await until(() => harness.notifications.length === 1);
		await harness.poller.stop();
	});
});
