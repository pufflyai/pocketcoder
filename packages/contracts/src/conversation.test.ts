import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ConversationMessageInputSchema } from "./conversation";
import { AgentFrameSchema, ExecSpecSchema, PROTOCOL_VERSION } from "./protocol";

test("restricted exec specs carry only local firewall endpoints", () => {
	const network = ExecSpecSchema.shape.network.parse({
		mode: "restricted",
		proxy_url: "http://127.0.0.1:18080",
		health_url: "http://127.0.0.1:18082/healthz",
	});
	expect(network.mode).toBe("restricted");
});

describe("conversation contracts", () => {
	test("accepts bounded canonical messages and protocol frames", () => {
		const payload = {
			message_id: "provider-message-1",
			role: "assistant" as const,
			content: "Implemented the change.",
			occurred_at: new Date().toISOString(),
			metadata: { provider: "agentapi" },
		};
		expect(ConversationMessageInputSchema.parse(payload)).toEqual(payload);
		expect(
			AgentFrameSchema.safeParse({
				v: PROTOCOL_VERSION,
				type: "conversation_message",
				workspace_id: randomUUID(),
				connection_id: randomUUID(),
				seq: 2,
				sent_at: new Date().toISOString(),
				payload,
			}).success,
		).toBe(true);
	});

	test("rejects oversized content and unbounded metadata", () => {
		expect(
			ConversationMessageInputSchema.safeParse({
				message_id: "m",
				role: "user",
				content: "x".repeat(256 * 1024 + 1),
				occurred_at: new Date().toISOString(),
				metadata: {},
			}).success,
		).toBe(false);
		expect(
			ConversationMessageInputSchema.safeParse({
				message_id: "m",
				role: "user",
				content: "ok",
				occurred_at: new Date().toISOString(),
				metadata: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`k${index}`, "v"])),
			}).success,
		).toBe(false);
	});
});
