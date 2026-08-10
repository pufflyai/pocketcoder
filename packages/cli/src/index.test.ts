import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface CliResult {
	exitCode: number;
	output: string;
}

interface RunCliOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
	keepStdinOpen?: boolean;
}

const pocketcoderEnvironment = [
	"POCKETCODER_AUTH_PEPPER",
	"POCKETCODER_DATABASE_SCHEMA",
	"POCKETCODER_DATABASE_URL",
	"POCKETCODER_HOST",
	"POCKETCODER_KEY",
	"POCKETCODER_PORT",
	"POCKETCODER_STATE_DIR",
	"POCKETCODER_STORE",
	"POCKETCODER_TEMPLATE_DIR",
	"POCKETCODER_URL",
];

function freePort(): number {
	const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
	const port = Number(probe.port);
	probe.stop(true);
	return port;
}

async function runCli(args: readonly string[], options: RunCliOptions = {}): Promise<CliResult> {
	const env: Record<string, string | undefined> = { ...Bun.env, NO_COLOR: "1" };
	delete env.FORCE_COLOR;
	for (const key of pocketcoderEnvironment) delete env[key];
	Object.assign(env, options.env);
	const child = Bun.spawn(
		[process.execPath, "--no-env-file", resolve(import.meta.dir, "index.ts"), ...args],
		{
			cwd: options.cwd ?? resolve(import.meta.dir, ".."),
			env,
			...(options.keepStdinOpen ? { stdin: "pipe" } : {}),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, output: `${stdout}${stderr}` };
}

describe("pcd version", () => {
	test("prints the published package version", async () => {
		const { version } = await Bun.file(resolve(import.meta.dir, "../package.json")).json();
		const result = await runCli(["--version"]);

		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe(version);
	});

	test("leaves --version to the template version on workspaces create", async () => {
		const result = await runCli(["workspaces", "create", "--help"]);

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("Template version");
		expect(result.output).not.toContain("Show version number");
	});
});

describe("pcd help", () => {
	test("prints root help successfully", async () => {
		const result = await runCli(["--help"]);

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("pcd <command>");
		expect(result.output).toContain("pcd workspaces <command>");
	});

	test("a missing root command prints help and fails", async () => {
		const result = await runCli([]);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("pcd <command>");
		expect(result.output).toContain("A command is required.");
	});

	test.each(["server", "db", "principals", "keys", "templates", "pools", "workspaces"])(
		"a missing %s subcommand prints group help and fails",
		async (group) => {
			const result = await runCli([group]);

			expect(result.exitCode).toBe(1);
			expect(result.output).toContain(`pcd ${group} <command>`);
			expect(result.output).toContain("Not enough non-option arguments");
		},
	);

	test.each([
		{
			args: ["principals", "create"],
			usage: "pcd principals create",
			error: "Missing required arguments: name, scopes",
		},
		{
			args: ["principals", "update"],
			usage: "pcd principals update",
			error: "Missing required arguments: name, scopes",
		},
		{
			args: ["keys", "issue"],
			usage: "pcd keys issue",
			error: "Missing required argument: principal",
		},
		{
			args: ["keys", "revoke"],
			usage: "pcd keys revoke",
			error: "Missing required argument: id",
		},
		{
			args: ["templates", "validate"],
			usage: "pcd templates validate <files..>",
			error: "Not enough non-option arguments",
		},
		{
			args: ["workspaces", "create"],
			usage: "pcd workspaces create",
			error: "Missing required argument: template",
		},
		{
			args: ["workspaces", "get"],
			usage: "pcd workspaces get",
			error: "Missing required argument: id",
		},
		{
			args: ["workspaces", "logs"],
			usage: "pcd workspaces logs",
			error: "Missing required argument: id",
		},
		{
			args: ["workspaces", "network-events"],
			usage: "pcd workspaces network-events",
			error: "Missing required argument: id",
		},
		{
			args: ["workspaces", "terminal"],
			usage: "pcd workspaces terminal",
			error: "Missing required argument: id",
		},
		{
			args: ["workspaces", "terminal-sessions"],
			usage: "pcd workspaces terminal-sessions",
			error: "Missing required argument: id",
		},
		{
			args: ["workspaces", "cancel"],
			usage: "pcd workspaces cancel",
			error: "Missing required argument: id",
		},
		{
			args: ["doctor"],
			usage: "pcd doctor",
			error: "Missing required argument: template",
		},
	])(
		"$usage prints command help when required arguments are missing",
		async ({ args, usage, error }) => {
			const result = await runCli(args);

			expect(result.exitCode).toBe(1);
			expect(result.output).toContain(usage);
			expect(result.output).toContain("Options:");
			expect(result.output).toContain(error);
		},
	);
});

describe("pcd server lifecycle", () => {
	test("starts, reports, and stops only the managed server process", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pocketcoder-cli-server-"));
		const port = freePort();
		const env = {
			POCKETCODER_HOST: "127.0.0.1",
			POCKETCODER_PORT: String(port),
			POCKETCODER_STATE_DIR: directory,
			POCKETCODER_STORE: "memory",
		};
		try {
			const started = await runCli(["server", "start"], { env });
			expect(started.exitCode).toBe(0);
			expect(started.output).toContain("pocketcoder-server started");

			const status = await runCli(["server", "status", "--json"], { env });
			expect(status.exitCode).toBe(0);
			expect(status.output).toContain('"state": "running"');

			const health = await fetch(`http://127.0.0.1:${port}/readyz`);
			expect(health.status).toBe(200);

			const stopped = await runCli(["server", "stop"], { env });
			expect(stopped.exitCode).toBe(0);
			expect(stopped.output).toContain("pocketcoder-server stopped");

			const after = await runCli(["server", "status"], { env });
			expect(after.exitCode).toBe(1);
			expect(after.output).toContain("no managed server state");
		} finally {
			await runCli(["server", "stop"], { env }).catch(() => {});
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("refuses to stop a PID whose process identity does not match", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pocketcoder-cli-server-state-"));
		try {
			writeFileSync(
				join(directory, "server.json"),
				JSON.stringify({
					version: 1,
					pid: process.pid,
					instanceToken: "not-present-in-the-process-command",
					url: "http://127.0.0.1:1",
					startedAt: new Date().toISOString(),
					configFingerprint: "test",
					logPath: join(directory, "server.log"),
				}),
			);
			const stopped = await runCli(["server", "stop"], {
				env: { POCKETCODER_STATE_DIR: directory },
			});
			expect(stopped.exitCode).toBe(1);
			expect(stopped.output).toContain("process identity does not match");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("pcd workspace workflows", () => {
	const waitingWorkspaceId = "11111111-1111-4111-8111-111111111111";
	const failedWorkspaceId = "22222222-2222-4222-8222-222222222222";
	function workspaceResource(
		id: string,
		state: "queued" | "ready" | "failed",
		changeCursor: number,
	) {
		return {
			id,
			external_id: `external-${id}`,
			template: { name: "pi-harness", version: "1", digest: "sha256:template" },
			state,
			reason_code: state === "failed" ? "launch_failed" : null,
			agent_state: state === "ready" ? "stable" : "unknown",
			change_cursor: changeCursor,
			provider_kind: null,
			provisioning_mode: null,
			network: { state: state === "ready" ? "ready" : "starting" },
			health: {},
			created_at: "2026-01-01T00:00:00Z",
			updated_at: "2026-01-01T00:00:00Z",
			connected_at: state === "ready" ? "2026-01-01T00:00:01Z" : null,
			ready_at: state === "ready" ? "2026-01-01T00:00:02Z" : null,
			deadline_at: "2026-01-01T01:00:00Z",
			terminal_at: state === "failed" ? "2026-01-01T00:00:02Z" : null,
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
							log_tail: "docker image is unavailable",
							log_tail_truncated: false,
							last_log_seq: 1,
						}
					: null,
		};
	}

	test("creates a workspace and waits for the durable ready change", async () => {
		let changeReads = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				const url = new URL(request.url);
				if (request.method === "POST" && url.pathname === "/v1/workspaces") {
					return Response.json(workspaceResource(waitingWorkspaceId, "queued", 1), { status: 201 });
				}
				if (
					request.method === "GET" &&
					url.pathname === `/v1/workspaces/${waitingWorkspaceId}/changes`
				) {
					changeReads += 1;
					expect(url.searchParams.get("after")).toBe("1");
					return Response.json({
						cursor: 2,
						changed: true,
						workspace: workspaceResource(waitingWorkspaceId, "ready", 2),
					});
				}
				return new Response("not found", { status: 404 });
			},
		});
		try {
			const result = await runCli(
				[
					"workspaces",
					"create",
					"--template",
					"pi-harness",
					"--wait",
					"--json",
					"--wait-timeout-seconds",
					"2",
				],
				{
					env: {
						POCKETCODER_URL: server.url.origin,
						POCKETCODER_KEY: "wait-key",
					},
				},
			);
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.output)).toMatchObject({
				id: waitingWorkspaceId,
				state: "ready",
			});
			expect(changeReads).toBe(1);
		} finally {
			await server.stop(true);
		}
	});

	test("prints bounded launch failure evidence while waiting", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				const url = new URL(request.url);
				if (request.method === "POST" && url.pathname === "/v1/workspaces") {
					return Response.json(workspaceResource(failedWorkspaceId, "queued", 1), { status: 201 });
				}
				if (url.pathname.endsWith("/changes")) {
					return Response.json({
						cursor: 2,
						changed: true,
						workspace: workspaceResource(failedWorkspaceId, "failed", 2),
					});
				}
				return new Response("not found", { status: 404 });
			},
		});
		try {
			const result = await runCli(["workspaces", "create", "--template", "pi-harness", "--wait"], {
				env: {
					POCKETCODER_URL: server.url.origin,
					POCKETCODER_KEY: "wait-key",
				},
			});
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain("launch_failed");
			expect(result.output).toContain("docker image is unavailable");
		} finally {
			await server.stop(true);
		}
	});

	test("sends a chat turn and prints the correlated agent response", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pocketcoder-cli-chat-"));
		let prompt = "";
		let status = "stable";
		let statusReads = 0;
		const messages = [
			{ id: 0, role: "agent", content: "startup" },
			{ id: 1, role: "user", content: "old prompt" },
			{ id: 2, role: "agent", content: "old reply" },
		];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const url = new URL(request.url);
				const route = `${request.method} ${url.pathname}`;
				if (route === "GET /v1/workspaces/workspace-chat") {
					statusReads += 1;
					if (status === "running" && statusReads > 2) {
						messages.push({ id: 4, role: "agent", content: `reply: ${prompt}` });
						status = "stable";
					}
					return Response.json({
						id: "workspace-chat",
						state: "ready",
						agent_state: status,
					});
				}
				if (route === "POST /v1/workspaces/workspace-chat/agent/message") {
					const body = (await request.json()) as { content: string };
					prompt = body.content;
					status = "running";
					messages.push({ id: 3, role: "user", content: prompt });
					return Response.json({ ok: true });
				}
				if (route === "GET /v1/workspaces/workspace-chat/agent/messages") {
					return Response.json({ messages });
				}
				return new Response("not found", { status: 404 });
			},
		});
		try {
			const result = await runCli(
				[
					"workspaces",
					"chat",
					"--id",
					"workspace-chat",
					"--message",
					"hello",
					"--json",
					"--poll-interval-ms",
					"100",
					"--response-timeout-seconds",
					"2",
				],
				{
					env: {
						POCKETCODER_URL: server.url.origin,
						POCKETCODER_KEY: "chat-key",
						POCKETCODER_STATE_DIR: directory,
					},
				},
			);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain('"role":"agent"');
			expect(result.output).toContain("reply: hello");
			expect(result.output).not.toContain("startup");
			expect(result.output).not.toContain("old reply");
		} finally {
			await server.stop(true);
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("pcd terminal workflow", () => {
	test("bridges terminal output and exits with the remote command code", async () => {
		const workspaceId = "55555555-5555-4555-8555-555555555555";
		const sessionId = "66666666-6666-4666-8666-666666666666";
		let authorization = "";
		const server = Bun.serve<{ authorized: boolean }>({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, bunServer) {
				authorization = request.headers.get("authorization") ?? "";
				if (
					bunServer.upgrade(request, {
						data: { authorized: authorization === "Bearer terminal-key" },
					})
				) {
					return;
				}
				return new Response("upgrade required", { status: 426 });
			},
			websocket: {
				message() {},
				open(socket) {
					if (!socket.data.authorized) {
						socket.close(1008, "unauthorized");
						return;
					}
					setTimeout(() => {
						socket.send(JSON.stringify({ type: "opened", session_id: sessionId }));
						socket.send(
							JSON.stringify({
								type: "output",
								data_b64: Buffer.from("terminal output\n").toString("base64"),
							}),
						);
						socket.send(JSON.stringify({ type: "closed", reason: "exit", exit_code: 3 }));
					}, 10);
				},
			},
		});
		try {
			const result = await runCli(["workspaces", "terminal", "--id", workspaceId], {
				env: {
					POCKETCODER_URL: server.url.origin,
					POCKETCODER_KEY: "terminal-key",
				},
				keepStdinOpen: true,
			});
			expect(result).toMatchObject({
				exitCode: 3,
				output: expect.stringContaining("terminal output"),
			});
			expect(authorization).toBe("Bearer terminal-key");
		} finally {
			await server.stop(true);
		}
	}, 5000);
});

const doctorWorkspaceId = "33333333-3333-4333-8333-333333333333";
const statusOnlyWorkspaceId = "44444444-4444-4444-8444-444444444444";

function doctorWorkspace(id: string, state: "ready" | "canceled") {
	return {
		id,
		external_id: `external-${id}`,
		template: { name: "fixture-echo", version: "1", digest: "sha256:template" },
		state,
		reason_code: null,
		agent_state: state === "ready" ? "stable" : "unknown",
		change_cursor: 1,
		provider_kind: null,
		provisioning_mode: null,
		network: { state: state === "ready" ? "ready" : "starting" },
		health: {},
		created_at: "2026-01-01T00:00:00Z",
		updated_at: "2026-01-01T00:00:00Z",
		connected_at: state === "ready" ? "2026-01-01T00:00:01Z" : null,
		ready_at: state === "ready" ? "2026-01-01T00:00:02Z" : null,
		deadline_at: "2026-01-01T01:00:00Z",
		terminal_at: state === "canceled" ? "2026-01-01T00:00:03Z" : null,
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
		failure: null,
	};
}

describe("pcd commands", () => {
	test("passes JSON launch input to restore and recreate", async () => {
		const requests: Array<{ path: string; body: unknown }> = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				requests.push({
					path: new URL(request.url).pathname,
					body: await request.json(),
				});
				return Response.json(
					{
						error: {
							code: "validation.invalid",
							message: "fixture response",
							request_id: "request-restore",
						},
					},
					{ status: 400 },
				);
			},
		});
		const env = {
			POCKETCODER_URL: server.url.origin,
			POCKETCODER_KEY: "restore-key",
		};
		try {
			const restore = await runCli(
				[
					"workspaces",
					"restore",
					"--checkpoint",
					"checkpoint",
					"--external-id",
					"restored",
					"--input",
					'{"bootstrap_token":"restore-envelope"}',
				],
				{ env },
			);
			const recreate = await runCli(
				[
					"workspaces",
					"recreate",
					"--id",
					"workspace",
					"--external-id",
					"recreated",
					"--input",
					'{"bootstrap_token":"recreate-envelope"}',
				],
				{ env },
			);

			expect(restore.output).toContain("fixture response");
			expect(recreate.output).toContain("fixture response");
			expect(requests).toEqual([
				{
					path: "/v1/checkpoints/checkpoint/restore",
					body: {
						external_id: "restored",
						launch_input: { bootstrap_token: "restore-envelope" },
					},
				},
				{
					path: "/v1/workspaces/workspace/recreate",
					body: {
						external_id: "recreated",
						launch_input: { bootstrap_token: "recreate-envelope" },
					},
				},
			]);
		} finally {
			await server.stop(true);
		}
	});

	test("validates a template through the yargs command tree", async () => {
		const template = resolve(import.meta.dir, "../../../examples/templates/fixture-echo.json");
		const result = await runCli(["templates", "validate", template]);

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("fixture-echo@1.0.0");
		expect(result.output).toContain(": ok (");
	});

	test("renders JSON and YAML templates to the same canonical output", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pocketcoder-render-"));
		const jsonPath = join(directory, "template.json");
		const yamlPath = join(directory, "template.yaml");
		const jsonOut = join(directory, "json-out");
		const yamlOut = join(directory, "yaml-out");
		const image = `registry.test/agent@sha256:${"1".repeat(64)}`;
		const input = {
			apiVersion: "pocketcoder.dev/v1alpha1",
			kind: "Template",
			metadata: { name: "rendered", description: "fixture" },
			spec: {
				version: "1.0.0",
				image: `registry.test/agent@sha256:${"0".repeat(64)}`,
				agent: { type: "codex", command: ["codex"], env: { MODEL: "default" } },
				resources: { cpu: "1", memory: "1Gi" },
			},
		};
		writeFileSync(jsonPath, JSON.stringify(input, null, 2));
		writeFileSync(
			yamlPath,
			`apiVersion: pocketcoder.dev/v1alpha1
kind: Template
metadata:
  name: rendered
  description: fixture
spec:
  version: 1.0.0
  image: ${input.spec.image}
  agent:
    type: codex
    command: [codex]
    env:
      MODEL: default
  resources:
    cpu: "1"
    memory: 1Gi
`,
		);
		const originalJson = readFileSync(jsonPath, "utf8");
		try {
			for (const [source, out] of [
				[jsonPath, jsonOut],
				[yamlPath, yamlOut],
			] as const) {
				const result = await runCli([
					"templates",
					"render",
					source,
					"--image",
					image,
					"--set",
					'/spec/agent/env/MODEL="gpt-5"',
					"--out",
					out,
				]);
				expect(result.exitCode).toBe(0);
				expect(result.output).toContain("rendered@1.0.0-");
			}
			expect(readFileSync(join(jsonOut, "rendered.json"), "utf8")).toBe(
				readFileSync(join(yamlOut, "rendered.json"), "utf8"),
			);
			expect(readFileSync(jsonPath, "utf8")).toBe(originalJson);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("pcd doctor", () => {
	test("doctor completes a correlated turn and always cancels its workspace", async () => {
		let diagnosticPrompt = "";
		let canceled = false;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This single fixture router makes every doctor request explicit.
			async fetch(request) {
				const url = new URL(request.url);
				if (request.method === "POST" && url.pathname === "/v1/workspaces") {
					expect(request.headers.get("idempotency-key")).toStartWith("doctor-");
					return Response.json(doctorWorkspace(doctorWorkspaceId, "ready"), { status: 201 });
				}
				if (request.method === "GET" && url.pathname === `/v1/workspaces/${doctorWorkspaceId}`) {
					return Response.json(doctorWorkspace(doctorWorkspaceId, "ready"));
				}
				if (
					request.method === "GET" &&
					url.pathname === `/v1/workspaces/${doctorWorkspaceId}/agent/status`
				) {
					return Response.json({ status: "stable" });
				}
				if (
					request.method === "POST" &&
					url.pathname === `/v1/workspaces/${doctorWorkspaceId}/agent/message`
				) {
					const body = (await request.json()) as { content: string };
					diagnosticPrompt = body.content;
					return Response.json({ ok: true });
				}
				if (
					request.method === "GET" &&
					url.pathname === `/v1/workspaces/${doctorWorkspaceId}/agent/messages`
				) {
					return Response.json({
						messages: [{ id: 1, role: "assistant", content: diagnosticPrompt }],
					});
				}
				if (
					request.method === "POST" &&
					url.pathname === `/v1/workspaces/${doctorWorkspaceId}/cancel`
				) {
					canceled = true;
					return Response.json(doctorWorkspace(doctorWorkspaceId, "canceled"));
				}
				return new Response("not found", { status: 404 });
			},
		});
		try {
			const result = await runCli(["doctor", "--template", "fixture-echo"], {
				env: {
					POCKETCODER_URL: server.url.origin,
					POCKETCODER_KEY: "doctor-key",
				},
			});
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("doctor: correlated agent response received");
			expect(result.output).toContain("doctor: ok");
			expect(canceled).toBe(true);
		} finally {
			await server.stop(true);
		}
	});

	test("doctor rejects a status-only harness and still cancels", async () => {
		let canceled = false;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				const url = new URL(request.url);
				if (request.method === "POST" && url.pathname === "/v1/workspaces") {
					return Response.json(doctorWorkspace(statusOnlyWorkspaceId, "ready"), { status: 201 });
				}
				if (
					request.method === "GET" &&
					url.pathname === `/v1/workspaces/${statusOnlyWorkspaceId}`
				) {
					return Response.json(doctorWorkspace(statusOnlyWorkspaceId, "ready"));
				}
				if (
					request.method === "GET" &&
					url.pathname === `/v1/workspaces/${statusOnlyWorkspaceId}/agent/status`
				) {
					return Response.json({ status: "stable" });
				}
				if (
					request.method === "POST" &&
					url.pathname === `/v1/workspaces/${statusOnlyWorkspaceId}/cancel`
				) {
					canceled = true;
					return Response.json(doctorWorkspace(statusOnlyWorkspaceId, "canceled"));
				}
				return new Response("not found", { status: 404 });
			},
		});
		try {
			const result = await runCli(
				["doctor", "--template", "status-only", "--turn-timeout-seconds", "1"],
				{
					env: {
						POCKETCODER_URL: server.url.origin,
						POCKETCODER_KEY: "doctor-key",
					},
				},
			);
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain("agent message probe failed (404)");
			expect(canceled).toBe(true);
		} finally {
			await server.stop(true);
		}
	});
});

describe("pcd environment", () => {
	test("loads .env from the nearest project directory", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pocketcoder-cli-"));
		const nested = join(directory, "nested");
		mkdirSync(nested);
		const authorizations: Array<string | null> = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				authorizations.push(request.headers.get("authorization"));
				return Response.json({ items: [], next_cursor: null });
			},
		});
		try {
			writeFileSync(
				join(directory, ".env"),
				`POCKETCODER_URL=${server.url.origin}\nPOCKETCODER_KEY=from-dotenv\n`,
			);

			const result = await runCli(["workspaces", "list"], { cwd: nested });

			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("(no workspaces)");
			expect(authorizations).toEqual(["Bearer from-dotenv"]);
		} finally {
			await server.stop(true);
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("keeps exported environment variables above .env values", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pocketcoder-cli-"));
		const authorizations: Array<string | null> = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				authorizations.push(request.headers.get("authorization"));
				return Response.json({ items: [], next_cursor: null });
			},
		});
		try {
			writeFileSync(
				join(directory, ".env"),
				`POCKETCODER_URL=${server.url.origin}\nPOCKETCODER_KEY=from-dotenv\n`,
			);

			const result = await runCli(["workspaces", "list"], {
				cwd: directory,
				env: { POCKETCODER_KEY: "from-shell" },
			});

			expect(result.exitCode).toBe(0);
			expect(authorizations).toEqual(["Bearer from-shell"]);
		} finally {
			await server.stop(true);
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("supports explicit work directories and environment files", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pocketcoder-cli-"));
		const invocationDirectory = mkdtempSync(join(tmpdir(), "pocketcoder-cli-cwd-"));
		const authorizations: Array<string | null> = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				authorizations.push(request.headers.get("authorization"));
				return Response.json({ items: [], next_cursor: null });
			},
		});
		try {
			writeFileSync(
				join(directory, "staging.env"),
				`POCKETCODER_URL=${server.url.origin}\nPOCKETCODER_KEY=from-explicit-file\n`,
			);

			const result = await runCli(
				["--workdir", directory, "--env-file", "staging.env", "workspaces", "list"],
				{ cwd: invocationDirectory },
			);

			expect(result.exitCode).toBe(0);
			expect(authorizations).toEqual(["Bearer from-explicit-file"]);
		} finally {
			await server.stop(true);
			rmSync(directory, { recursive: true, force: true });
			rmSync(invocationDirectory, { recursive: true, force: true });
		}
	});
});
