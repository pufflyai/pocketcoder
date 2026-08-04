import { describe, expect, test } from "bun:test";
import { AuditQueue } from "./audit";

const event = (sourceSeq: number) => ({
	source_seq: sourceSeq,
	occurred_at: new Date().toISOString(),
	decision: "allow" as const,
	transport: "http" as const,
	host: "github.com",
	port: 443,
	method: "GET",
	path: "/",
	matched_rule: "github.com",
	reason: "matched_rule",
});

describe("audit upload queue", () => {
	test("retries the same source sequence without dropping the event", async () => {
		let requests = 0;
		let uploaded!: () => void;
		const accepted = new Promise<void>((resolve) => {
			uploaded = resolve;
		});
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				requests += 1;
				const batch = (await request.json()) as { events: Array<{ source_seq: number }> };
				expect(batch.events[0]?.source_seq).toBe(1);
				if (requests === 1) return new Response("retry", { status: 500 });
				uploaded();
				return new Response(null, { status: 202 });
			},
		});
		const queue = new AuditQueue(`http://127.0.0.1:${server.port}`, "token");
		try {
			queue.record(event(1));
			await Promise.race([
				accepted,
				new Promise((_, reject) => setTimeout(() => reject(new Error("upload timed out")), 2000)),
			]);
			expect(requests).toBe(2);
		} finally {
			queue.close();
			server.stop(true);
		}
	});

	test("closes admission at the bounded event count", () => {
		const queue = new AuditQueue("http://127.0.0.1:1", "token");
		for (let index = 1; index <= 1_000; index += 1) queue.record(event(index));
		expect(queue.canAccept()).toBe(false);
		queue.close();
	});
});
