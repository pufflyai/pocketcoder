import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pumpLineFramedText, splitUtf8Chunks, verifyWritableMemoryPaths } from "./supervisor";

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
