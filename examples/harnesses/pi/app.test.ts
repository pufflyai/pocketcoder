import { describe, expect, test } from "bun:test";
import { type CodingSession, PiHarness } from "./app";

class FakeSession implements CodingSession {
	disposed = false;

	async prompt(content: string): Promise<string> {
		await Bun.sleep(20);
		return `pi: ${content}`;
	}

	dispose(): void {
		this.disposed = true;
	}
}

describe("Pi harness HTTP contract", () => {
	test("reports health, accepts a prompt, and exposes the conversation", async () => {
		const session = new FakeSession();
		const harness = new PiHarness(session);

		const initial = await harness.fetch(new Request("http://127.0.0.1/status"));
		expect(await initial.json()).toEqual({ status: "stable" });

		const accepted = await harness.fetch(
			new Request("http://127.0.0.1/message", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ content: "hello" }),
			}),
		);
		expect(accepted.status).toBe(200);
		expect(await accepted.json()).toEqual({ accepted: true, message_id: "1" });

		const running = await harness.fetch(new Request("http://127.0.0.1/status"));
		expect(await running.json()).toEqual({ status: "running" });
		await harness.whenIdle();

		const conversation = await harness.fetch(new Request("http://127.0.0.1/messages"));
		expect(await conversation.json()).toEqual({
			messages: [
				expect.objectContaining({ id: "1", role: "user", content: "hello" }),
				expect.objectContaining({ id: "2", role: "assistant", content: "pi: hello" }),
			],
		});

		await harness.close();
		expect(session.disposed).toBe(true);
	});

	test("rejects invalid input", async () => {
		const harness = new PiHarness(new FakeSession());
		const response = await harness.fetch(
			new Request("http://127.0.0.1/message", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ content: "" }),
			}),
		);
		expect(response.status).toBe(400);
	});
});
