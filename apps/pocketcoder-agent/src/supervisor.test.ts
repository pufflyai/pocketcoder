import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	POOL_PROTOCOL_VERSION,
	PROTOCOL_VERSION,
	type ProviderInput,
} from "@pstdio/pocketcoder-contracts";
import {
	enforcedEnvironment,
	isConversationControlLine,
	pumpLineFramedText,
	splitUtf8Chunks,
	verifyWritableMemoryPaths,
	waitForPoolLease,
} from "./supervisor";
import { SupervisorLogs } from "./supervisor-logs";

test("restricted child environments cannot replace enforced proxy variables", () => {
	const exec = {
		network: {
			mode: "restricted" as const,
			proxy_url: "http://127.0.0.1:18080",
			health_url: "http://127.0.0.1:18082/healthz",
		},
		env: { HTTP_PROXY: "http://template.invalid" },
	} as unknown as Parameters<typeof enforcedEnvironment>[0];
	const environment = enforcedEnvironment(exec, {
		https_proxy: "http://step.invalid",
		ALL_PROXY: "socks5://bypass.invalid",
	});
	expect(environment.HTTP_PROXY).toBe("http://127.0.0.1:18080");
	expect(environment.https_proxy).toBe("http://127.0.0.1:18080");
	expect(environment.ALL_PROXY).toBe("");
	expect(environment.NO_PROXY).toBe("127.0.0.1,localhost,::1");
});

test("setup credentials are redacted from child output", async () => {
	const frames: Array<{ type: string; payload: unknown }> = [];
	const logs = new SupervisorLogs((type, payload) => {
		frames.push({ type, payload });
		return true;
	});
	logs.addSecret("short-lived-git-token");
	await logs.pump(new Response("clone failed for short-lived-git-token\n").body, "stderr");
	const content = frames
		.map((frame) =>
			frame.type === "log_chunk" ? (frame.payload as { content_b64: string }) : null,
		)
		.filter((payload): payload is { content_b64: string } => payload !== null)
		.map((payload) => Buffer.from(payload.content_b64, "base64").toString("utf8"))
		.join("");
	expect(content).toContain("[redacted]");
	expect(content).not.toContain("short-lived-git-token");
});

describe("warm pool bootstrap", () => {
	test("waits unbound and returns only the post-commit in-memory assignment", async () => {
		const runtimeId = randomUUID();
		const workspaceId = randomUUID();
		const assignment: ProviderInput = {
			workspace_id: workspaceId,
			server_url: "http://workspace-server:7080",
			registration_secret: "workspace-one-time",
			template_digest: "sha256:template",
			template_name: "fixture",
			template_version: "1.0.0",
			launch_mode: "create",
			launch_input: { task: "delivered-after-lease" },
		};
		let enrollmentHeader = "";
		const server = Bun.serve({
			port: 0,
			fetch(request, server) {
				enrollmentHeader = request.headers.get("x-pocketcoder-pool-enrollment") ?? "";
				if (server.upgrade(request)) return;
				return new Response("upgrade required", { status: 426 });
			},
			websocket: {
				message(ws, message) {
					const registered = JSON.parse(String(message)) as {
						type: string;
						pool_runtime_id: string;
					};
					expect(registered).toEqual(
						expect.objectContaining({ type: "pool_registered", pool_runtime_id: runtimeId }),
					);
					ws.send(
						JSON.stringify({
							v: POOL_PROTOCOL_VERSION,
							type: "lease_assignment",
							input: assignment,
						}),
					);
				},
			},
		});
		try {
			const received = await waitForPoolLease({
				pool_runtime_id: runtimeId,
				server_url: `http://127.0.0.1:${server.port}`,
				enrollment_secret: "pool-one-time",
				template_digest: "sha256:template",
				template_name: "fixture",
				template_version: "1.0.0",
			});
			expect(enrollmentHeader).toBe("pool-one-time");
			expect(received).toEqual(assignment);
		} finally {
			await server.stop(true);
		}
	});
});

describe("process signals", () => {
	test("SIGTERM gracefully stops the harness before the supervisor exits", async () => {
		const root = await mkdtemp(join(tmpdir(), "pocketcoder-supervisor-signal-"));
		const markerPath = join(root, "saved.txt");
		const readyPath = join(root, "ready.txt");
		const harnessPath = join(root, "harness.ts");
		const inputPath = join(root, "input.json");
		const workspaceId = randomUUID();
		let markRunning!: () => void;
		const running = new Promise<void>((resolveRunning) => {
			markRunning = resolveRunning;
		});
		const server = Bun.serve({
			port: 0,
			fetch(request, server) {
				if (server.upgrade(request)) return;
				return new Response("upgrade required", { status: 426 });
			},
			websocket: {
				message(ws, message) {
					const frame = JSON.parse(String(message)) as {
						type: string;
						connection_id: string;
						payload?: { phase?: string };
					};
					if (frame.type === "registered") {
						ws.send(
							JSON.stringify({
								v: PROTOCOL_VERSION,
								type: "registered_ack",
								workspace_id: workspaceId,
								connection_id: frame.connection_id,
								seq: 1,
								sent_at: new Date().toISOString(),
								payload: {
									epoch: 1,
									reconnect_credential: "reconnect",
									limits: {
										max_frame_bytes: 1_048_576,
										max_inflight_relay: 8,
										log_chunk_bytes: 32_768,
										heartbeat_seconds: 15,
									},
									exec: {
										setup: [],
										harness: { command: [process.execPath, harnessPath], env: {} },
										env: {},
										services: {},
										timeouts: {
											start: "2s",
											maxAge: "1h",
											idle: "1h",
											disconnectGrace: "2s",
											terminateGrace: "2s",
										},
										security: { writable_memory_paths: [] },
										launch_mode: "create",
										source: null,
										restore: null,
										persistence: { mounts: [], conversation_restore: "filesystem_only" },
										checkpoint_hook: null,
										outputs: {},
									},
								},
							}),
						);
					}
					if (frame.type === "process_state" && frame.payload?.phase === "running") {
						markRunning();
					}
				},
			},
		});
		await writeFile(
			harnessPath,
			`process.once("SIGTERM", async () => { await Bun.write(${JSON.stringify(markerPath)}, "saved"); process.exit(0); }); await Bun.write(${JSON.stringify(readyPath)}, "ready"); setInterval(() => {}, 1000);\n`,
		);
		await writeFile(
			inputPath,
			JSON.stringify({
				workspace_id: workspaceId,
				server_url: `http://127.0.0.1:${server.port}`,
				registration_secret: "registration",
				template_digest: "sha256:signal-test",
				template_name: "signal-test",
				template_version: "1.0.0",
				launch_mode: "create",
			}),
		);
		const supervisor = Bun.spawn(
			[
				process.execPath,
				"--no-env-file",
				resolve(import.meta.dir, "index.ts"),
				"supervise",
				"--launch-input",
				inputPath,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		try {
			await Promise.race([
				running,
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error("supervisor did not start harness")), 5000),
				),
			]);
			const readyDeadline = Date.now() + 5000;
			while (!(await Bun.file(readyPath).exists())) {
				if (Date.now() >= readyDeadline) throw new Error("harness did not become ready");
				await Bun.sleep(10);
			}
			process.kill(supervisor.pid, "SIGTERM");
			const exitCode = await supervisor.exited;
			expect(await Bun.file(markerPath).text()).toBe("saved");
			expect(exitCode).toBe(0);
		} finally {
			if (supervisor.exitCode === null) supervisor.kill("SIGKILL");
			await server.stop(true);
			await rm(root, { recursive: true, force: true });
		}
	}, 10_000);
});

describe("workspace preflight", () => {
	test("writes, syncs, reads, and removes a sentinel in every path", async () => {
		const root = await mkdtemp(join(tmpdir(), "pocketcoder-memory-probe-"));
		const first = await mkdtemp(join(root, "first-"));
		const second = await mkdtemp(join(root, "second-"));
		try {
			await verifyWritableMemoryPaths([first, second]);
			expect(await readdir(first)).toEqual([]);
			expect(await readdir(second)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("identifies the declared path that cannot be written", async () => {
		const missing = join(tmpdir(), `pocketcoder-missing-${crypto.randomUUID()}`);
		expect(verifyWritableMemoryPaths([missing])).rejects.toThrow(
			`writable memory preflight failed for ${missing}`,
		);
	});
});

describe("log framing", () => {
	test("recognizes conversation control lines so transcript content stays out of logs", () => {
		expect(
			isConversationControlLine(
				'POCKETCODER_CONVERSATION {"message_id":"m-1","content":"secret"}\n',
			),
		).toBe(true);
		expect(isConversationControlLine("ordinary harness output\n")).toBe(false);
	});

	test("filters canonical conversation lines from operational log emission", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(
						'POCKETCODER_CONVERSATION {"message_id":"m-1","content":"private"}\nordinary\n',
					),
				);
				controller.close();
			},
		});
		const logs: string[] = [];
		await pumpLineFramedText(stream, (line) => {
			if (!isConversationControlLine(line)) logs.push(line);
		});
		expect(logs).toEqual(["ordinary\n"]);
	});

	test("reassembles split UTF-8 input and emits complete lines", async () => {
		const source = new TextEncoder().encode(
			"Traceback (most recent call last):\nPermissionError: café/.pi\npartial",
		);
		const frames = [
			source.subarray(0, 17),
			source.subarray(17, source.indexOf(0xc3) + 1),
			source.subarray(source.indexOf(0xc3) + 1),
		];
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const frame of frames) controller.enqueue(frame);
				controller.close();
			},
		});
		const emitted: string[] = [];

		await pumpLineFramedText(stream, (text) => emitted.push(text));

		expect(emitted).toEqual([
			"Traceback (most recent call last):\n",
			"PermissionError: café/.pi\n",
			"partial",
		]);
	});

	test("splits oversized lines only at UTF-8 code point boundaries", () => {
		const chunks = splitUtf8Chunks("åååå", 5);
		expect(chunks).toEqual(["åå", "åå"]);
		expect(chunks.every((chunk) => Buffer.byteLength(chunk) <= 5)).toBe(true);
	});
});
