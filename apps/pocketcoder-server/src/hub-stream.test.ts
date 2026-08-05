import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { WSContext } from "hono/ws";
import { Hub } from "./hub";

function liveHub(protocolVersion: 4 | 5 = 5) {
	const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
	const ws = {
		send(data: string) {
			const frame = JSON.parse(data) as {
				type: string;
				payload: Record<string, unknown>;
			};
			sent.push(frame);
		},
		close() {},
	} as unknown as WSContext;
	const hub = new Hub();
	const workspaceId = randomUUID();
	const connection = hub.attach(workspaceId, randomUUID(), 1, ws, protocolVersion);
	connection.registered = true;
	return { connection, hub, sent, workspaceId };
}

function request() {
	return {
		service: "agent",
		method: "GET" as const,
		path: "/events",
		query: {},
		headers: { accept: "text/event-stream" },
		deadline_ms: 1_000,
	};
}

describe("streamed relay hub", () => {
	test("delivers ordered chunks before upstream EOF and acknowledges only on demand", async () => {
		const { connection, hub, sent, workspaceId } = liveHub();
		const pending = hub.relayStream(workspaceId, request(), 1_024);
		const requestId = sent[0]?.payload.request_id as string;
		hub.startRelayStream(connection, {
			request_id: requestId,
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
		const response = await pending;
		if (!response.body) throw new Error("expected streamed response body");

		hub.pushRelayStreamChunk(connection, {
			request_id: requestId,
			seq: 0,
			content_b64: Buffer.from("first").toString("base64"),
		});
		expect(sent.some((frame) => frame.type === "proxy_stream_ack")).toBe(false);

		const reader = response.body.getReader();
		expect(Buffer.from((await reader.read()).value ?? []).toString()).toBe("first");
		expect(sent.at(-1)).toMatchObject({
			type: "proxy_stream_ack",
			payload: { request_id: requestId, seq: 0 },
		});

		hub.pushRelayStreamChunk(connection, {
			request_id: requestId,
			seq: 1,
			content_b64: Buffer.from("second").toString("base64"),
		});
		expect(Buffer.from((await reader.read()).value ?? []).toString()).toBe("second");
		hub.endRelayStream(connection, { request_id: requestId });
		expect((await reader.read()).done).toBe(true);
	});

	test("cancels the supervisor stream when the HTTP reader closes", async () => {
		const { connection, hub, sent, workspaceId } = liveHub();
		const pending = hub.relayStream(workspaceId, request(), 1_024);
		const requestId = sent[0]?.payload.request_id as string;
		hub.startRelayStream(connection, { request_id: requestId, status: 200, headers: {} });
		const response = await pending;
		if (!response.body) throw new Error("expected streamed response body");
		await response.body.cancel();
		expect(sent.at(-1)).toMatchObject({
			type: "proxy_stream_cancel",
			payload: { request_id: requestId, reason: "downstream_closed" },
		});
		expect(hub.activeStreamCount(workspaceId)).toBe(0);
	});

	test("rejects streaming before dispatch for protocol-v4 supervisors", async () => {
		const { hub, sent, workspaceId } = liveHub(4);
		const response = await hub.relayStream(workspaceId, request(), 1_024);
		expect(response.error_code).toBe("streaming_unsupported");
		expect(sent).toEqual([]);
	});

	test("errors the HTTP body and releases the channel when the supervisor disconnects", async () => {
		const { connection, hub, sent, workspaceId } = liveHub();
		const pending = hub.relayStream(workspaceId, request(), 1_024);
		const requestId = sent[0]?.payload.request_id as string;
		hub.startRelayStream(connection, { request_id: requestId, status: 200, headers: {} });
		const response = await pending;
		if (!response.body) throw new Error("expected streamed response body");
		const reading = response.body.getReader().read();

		expect(hub.detach(connection)).toBe(true);
		await expect(reading).rejects.toThrow("workspace disconnected");
		expect(hub.activeStreamCount(workspaceId)).toBe(0);
	});
});
