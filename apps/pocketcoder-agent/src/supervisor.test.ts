import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POOL_PROTOCOL_VERSION, type ProviderInput } from "@pstdio/pocketcoder-contracts";
import {
	isConversationControlLine,
	pumpLineFramedText,
	splitUtf8Chunks,
	verifyWritableMemoryPaths,
	waitForPoolLease,
} from "./supervisor";

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
