import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PROTOCOL_VERSION } from "@pstdio/pocketcoder-contracts";

test("native checkpoint synchronizes stable messages before gracefully stopping AgentAPI", async () => {
	const root = await mkdtemp(join(tmpdir(), "pocketcoder-native-agentapi-"));
	const harnessPath = join(root, "agentapi-child.ts");
	const inputPath = join(root, "input.json");
	const workspaceId = randomUUID();
	const operationId = randomUUID();
	const frames: Array<{ type: string; payload: Record<string, unknown> }> = [];
	let resolveQuiesced!: () => void;
	const quiesced = new Promise<void>((resolvePromise) => {
		resolveQuiesced = resolvePromise;
	});

	const agentapi = Bun.serve({
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/status") return Response.json({ status: "stable" });
			if (path === "/messages") {
				return Response.json({
					messages: [
						{
							id: 1,
							role: "user",
							content: "preserve this",
							time: "2026-08-03T12:00:00Z",
						},
						{
							id: 2,
							role: "agent",
							content: "saved",
							time: "2026-08-03T12:01:00Z",
						},
					],
				});
			}
			return new Response("not found", { status: 404 });
		},
	});

	let serverSeq = 0;
	const server = Bun.serve({
		port: 0,
		fetch(request, bunServer) {
			if (bunServer.upgrade(request)) return;
			return new Response("upgrade required", { status: 426 });
		},
		websocket: {
			message(ws, raw) {
				const frame = JSON.parse(String(raw)) as {
					type: string;
					connection_id: string;
					payload: Record<string, unknown>;
				};
				frames.push({ type: frame.type, payload: frame.payload });
				const send = (type: string, payload: Record<string, unknown>) => {
					serverSeq += 1;
					ws.send(
						JSON.stringify({
							v: PROTOCOL_VERSION,
							type,
							workspace_id: workspaceId,
							connection_id: frame.connection_id,
							seq: serverSeq,
							sent_at: new Date().toISOString(),
							payload,
						}),
					);
				};
				if (frame.type === "registered") {
					send("registered_ack", {
						epoch: 1,
						reconnect_credential: "reconnect",
						limits: {
							max_frame_bytes: 1_048_576,
							max_inflight_relay: 8,
							log_chunk_bytes: 32_768,
							heartbeat_seconds: 15,
						},
						exec: {
							agentapi_native: true,
							setup: [],
							harness: { command: [process.execPath, harnessPath], env: {} },
							env: {},
							services: {
								agent: {
									baseUrl: `http://127.0.0.1:${agentapi.port}`,
									required: true,
									healthPath: "/status",
									routes: [
										{ method: "GET", path: "/status" },
										{ method: "GET", path: "/messages" },
										{ method: "POST", path: "/message" },
									],
								},
							},
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
					});
				}
				if (frame.type === "process_state" && frame.payload.phase === "running") {
					send("prepare_checkpoint", { operation_id: operationId, deadline_ms: 2000 });
				}
				if (frame.type === "checkpoint_status" && frame.payload.phase === "quiesced") {
					resolveQuiesced();
				}
			},
		},
	});

	await writeFile(
		harnessPath,
		'process.once("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);\n',
	);
	await writeFile(
		inputPath,
		JSON.stringify({
			workspace_id: workspaceId,
			server_url: `http://127.0.0.1:${server.port}`,
			registration_secret: "registration",
			template_digest: "sha256:native-agentapi-test",
			template_name: "native-agentapi-test",
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
			quiesced,
			new Promise((_, reject) =>
				setTimeout(
					() => reject(new Error(`native checkpoint did not quiesce: ${JSON.stringify(frames)}`)),
					5000,
				),
			),
		]);
		const conversationIndexes = frames.flatMap((frame, index) =>
			frame.type === "conversation_message" ? [index] : [],
		);
		const quiescedIndex = frames.findIndex(
			(frame) => frame.type === "checkpoint_status" && frame.payload.phase === "quiesced",
		);
		expect(conversationIndexes).toHaveLength(2);
		expect(Math.max(...conversationIndexes)).toBeLessThan(quiescedIndex);
		expect(frames.filter((frame) => frame.type === "conversation_message")).toEqual([
			expect.objectContaining({ payload: expect.objectContaining({ message_id: "agentapi:1" }) }),
			expect.objectContaining({ payload: expect.objectContaining({ message_id: "agentapi:2" }) }),
		]);
	} finally {
		if (supervisor.exitCode === null) process.kill(supervisor.pid, "SIGTERM");
		await supervisor.exited;
		await server.stop(true);
		await agentapi.stop(true);
		await rm(root, { recursive: true, force: true });
	}
}, 10_000);
