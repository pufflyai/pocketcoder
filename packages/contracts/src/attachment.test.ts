import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	AgentMessageRequestSchema,
	ATTACHMENT_CHUNK_BYTES,
	ATTACHMENT_MAX_FILE_BYTES,
	ATTACHMENT_MAX_MESSAGE_BYTES,
	ATTACHMENT_MAX_MESSAGE_IDS,
	AttachmentDescriptorSchema,
	attachmentManifest,
	splitAttachmentManifest,
} from "./attachment";
import { ERROR_CODES } from "./errors";
import {
	AgentFrameSchema,
	ATTACHMENTS_MIN_PROTOCOL_VERSION,
	PROTOCOL_VERSION,
	ServerFrameSchema,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "./protocol";
import { SCOPES } from "./scopes";

function descriptor(overrides: Record<string, unknown> = {}) {
	return {
		id: randomUUID(),
		name: "report.pdf",
		path: "/home/pocketcoder/.pcd/attachments/x/report.pdf",
		media_type: "application/pdf",
		size_bytes: 42_137,
		sha256: "a".repeat(64),
		...overrides,
	};
}

describe("attachment limits", () => {
	test("bound files, message references, and chunk framing", () => {
		expect(ATTACHMENT_MAX_FILE_BYTES).toBe(25 * 1024 * 1024);
		expect(ATTACHMENT_MAX_MESSAGE_IDS).toBe(10);
		expect(ATTACHMENT_MAX_MESSAGE_BYTES).toBe(100 * 1024 * 1024);
		// Base64 expansion of a decoded chunk must stay under the 1 MiB frame cap.
		expect(Math.ceil(ATTACHMENT_CHUNK_BYTES / 3) * 4).toBeLessThan(1_048_576);
	});
});

describe("attachment descriptor", () => {
	test("accepts a complete descriptor", () => {
		expect(AttachmentDescriptorSchema.safeParse(descriptor()).success).toBe(true);
	});

	test("rejects invalid digests, sizes, media types, and names", () => {
		for (const bad of [
			descriptor({ sha256: "Z".repeat(64) }),
			descriptor({ sha256: "a".repeat(63) }),
			descriptor({ size_bytes: ATTACHMENT_MAX_FILE_BYTES + 1 }),
			descriptor({ size_bytes: -1 }),
			descriptor({ media_type: "not a mime" }),
			descriptor({ name: "" }),
			descriptor({ name: "x".repeat(256) }),
			descriptor({ id: "not-a-uuid" }),
		]) {
			expect(AttachmentDescriptorSchema.safeParse(bad).success).toBe(false);
		}
	});
});

describe("agent message request", () => {
	test("accepts a user message with unique attachment ids and keeps unknown fields", () => {
		const parsed = AgentMessageRequestSchema.safeParse({
			type: "user",
			content: "Summarize this.",
			attachment_ids: [randomUUID()],
			extra: "passthrough",
		});
		expect(parsed.success).toBe(true);
		expect((parsed.data as Record<string, unknown>).extra).toBe("passthrough");
	});

	test("rejects duplicates, empties, and oversized id lists", () => {
		const id = randomUUID();
		expect(
			AgentMessageRequestSchema.safeParse({
				type: "user",
				content: "x",
				attachment_ids: [id, id],
			}).success,
		).toBe(false);
		expect(
			AgentMessageRequestSchema.safeParse({ type: "user", content: "x", attachment_ids: [] })
				.success,
		).toBe(false);
		expect(
			AgentMessageRequestSchema.safeParse({
				type: "user",
				content: "x",
				attachment_ids: Array.from({ length: ATTACHMENT_MAX_MESSAGE_IDS + 1 }, () => randomUUID()),
			}).success,
		).toBe(false);
	});
});

describe("attachment manifest", () => {
	test("round-trips descriptors through message content", () => {
		const first = AttachmentDescriptorSchema.parse(descriptor());
		const second = AttachmentDescriptorSchema.parse(descriptor({ name: "data.csv" }));
		const content = `Summarize this.\n\n${attachmentManifest([first, second])}`;
		const split = splitAttachmentManifest(content);
		expect(split.text).toBe("Summarize this.");
		expect(split.attachments).toEqual([first, second]);
	});

	test("leaves plain content untouched", () => {
		const split = splitAttachmentManifest("no attachments here");
		expect(split.text).toBe("no attachments here");
		expect(split.attachments).toBeNull();
	});

	test("treats malformed manifests as plain text", () => {
		const content = "hi\n\n<pocketcoder-attachments>\nnot json\n</pocketcoder-attachments>";
		const split = splitAttachmentManifest(content);
		expect(split.text).toBe(content);
		expect(split.attachments).toBeNull();
	});
});

describe("protocol v3", () => {
	const envelope = {
		v: PROTOCOL_VERSION,
		workspace_id: randomUUID(),
		connection_id: randomUUID(),
		seq: 1,
		sent_at: new Date().toISOString(),
	};

	test("supports versions 1 through 3 and gates attachments on 3", () => {
		expect(SUPPORTED_PROTOCOL_VERSIONS).toEqual([1, 2, 3]);
		expect(PROTOCOL_VERSION).toBe(3);
		expect(ATTACHMENTS_MIN_PROTOCOL_VERSION).toBe(3);
	});

	test("validates the server-to-agent attachment frames", () => {
		const operationId = randomUUID();
		const frames = [
			{
				...envelope,
				type: "attachment_start",
				payload: {
					operation_id: operationId,
					attachment_id: randomUUID(),
					name: "report.pdf",
					media_type: "application/pdf",
					size_bytes: 10,
				},
			},
			{
				...envelope,
				type: "attachment_chunk",
				payload: { operation_id: operationId, seq: 0, content_b64: "aGVsbG8=" },
			},
			{ ...envelope, type: "attachment_finish", payload: { operation_id: operationId } },
			{
				...envelope,
				type: "attachment_abort",
				payload: { operation_id: operationId, reason: "caller canceled" },
			},
			{
				...envelope,
				type: "attachment_resolve",
				payload: { operation_id: operationId, attachment_ids: [randomUUID()] },
			},
		];
		for (const frame of frames) {
			expect(ServerFrameSchema.safeParse(frame).success).toBe(true);
		}
	});

	test("validates the agent-to-server attachment frames", () => {
		const operationId = randomUUID();
		const frames = [
			{
				...envelope,
				type: "attachment_ack",
				payload: { operation_id: operationId, seq: 0, received_bytes: 524_288 },
			},
			{
				...envelope,
				type: "attachment_result",
				payload: {
					operation_id: operationId,
					status: "created",
					descriptor: descriptor(),
				},
			},
			{
				...envelope,
				type: "attachment_result",
				payload: { operation_id: operationId, status: "failed", failure_code: "too_large" },
			},
			{
				...envelope,
				type: "attachment_resolved",
				payload: { operation_id: operationId, descriptors: [descriptor()] },
			},
			{
				...envelope,
				type: "attachment_resolved",
				payload: { operation_id: operationId, missing_id: randomUUID() },
			},
		];
		for (const frame of frames) {
			expect(AgentFrameSchema.safeParse(frame).success).toBe(true);
		}
	});
});

describe("authorization and errors", () => {
	test("registers the attachments:write scope", () => {
		expect(SCOPES).toContain("attachments:write");
	});

	test("registers the attachment error vocabulary with stable statuses", () => {
		expect(ERROR_CODES["attachment.invalid"]).toBe(400);
		expect(ERROR_CODES["attachment.too_large"]).toBe(413);
		expect(ERROR_CODES["attachment.not_found"]).toBe(404);
		expect(ERROR_CODES["attachment.conflict"]).toBe(409);
		expect(ERROR_CODES["attachment.unsupported"]).toBe(409);
		expect(ERROR_CODES["attachment.interrupted"]).toBe(503);
	});
});
