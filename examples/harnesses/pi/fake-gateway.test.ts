import { afterEach, describe, expect, test } from "bun:test";
import { PI_FIXTURE_CONTENT, startFakePiGateway } from "./fake-gateway";

let gateway: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
	gateway?.stop(true);
	gateway = undefined;
});

describe("Pi E2E fake model gateway", () => {
	test("asks Pi to read the fixture, then returns its contents", async () => {
		gateway = startFakePiGateway("test-bearer");
		const first = await fetch(`http://127.0.0.1:${gateway.port}/v1/chat/completions`, {
			method: "POST",
			headers: {
				authorization: "Bearer test-bearer",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: "pocketcoder-test",
				stream: true,
				messages: [{ role: "user", content: "read the file" }],
			}),
		});

		expect(first.status).toBe(200);
		expect(first.headers.get("content-type")).toContain("text/event-stream");
		const firstBody = await first.text();
		expect(firstBody).toContain('"name":"read"');
		expect(firstBody).toContain('\\"path\\":\\"/workspace/test.txt\\"');
		expect(firstBody).toContain('"finish_reason":"tool_calls"');

		const second = await fetch(`http://127.0.0.1:${gateway.port}/v1/chat/completions`, {
			method: "POST",
			headers: {
				authorization: "Bearer test-bearer",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: "pocketcoder-test",
				stream: true,
				messages: [
					{ role: "user", content: "read the file" },
					{ role: "tool", content: PI_FIXTURE_CONTENT },
				],
			}),
		});
		const secondBody = await second.text();
		expect(secondBody).toContain(`"content":"${PI_FIXTURE_CONTENT}"`);
		expect(secondBody).toContain('"finish_reason":"stop"');
		expect(secondBody).toEndWith("data: [DONE]\n\n");
	});
});
