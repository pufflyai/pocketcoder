import { z } from "zod";

// Workspace-native attachments: callers stream files into supervisor-owned
// storage and reference them by opaque ID. The control plane never persists
// attachment bytes or metadata; the workspace filesystem is the only store.

export const ATTACHMENT_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const ATTACHMENT_MAX_MESSAGE_IDS = 10;
export const ATTACHMENT_MAX_MESSAGE_BYTES = 100 * 1024 * 1024;
// Decoded chunk size; its base64 envelope stays under the 1 MiB frame cap.
export const ATTACHMENT_CHUNK_BYTES = 512 * 1024;

const MEDIA_TYPE_PATTERN = /^[\w.+-]+\/[\w.+-]+$/;

export const AttachmentMediaTypeSchema = z.string().regex(MEDIA_TYPE_PATTERN).max(255);

export const AttachmentDescriptorSchema = z.object({
	id: z.uuid(),
	name: z.string().min(1).max(255),
	path: z.string().min(1),
	media_type: AttachmentMediaTypeSchema,
	size_bytes: z.number().int().min(0).max(ATTACHMENT_MAX_FILE_BYTES),
	sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export type AttachmentDescriptor = z.infer<typeof AttachmentDescriptorSchema>;

// The AgentAPI message body with optional attachment references. Unknown
// fields pass through untouched so the relay stays protocol-neutral.
export const AgentMessageRequestSchema = z.looseObject({
	type: z.literal("user"),
	content: z.string(),
	attachment_ids: z
		.array(z.uuid())
		.min(1)
		.max(ATTACHMENT_MAX_MESSAGE_IDS)
		.refine((ids) => new Set(ids).size === ids.length, "attachment_ids must be unique")
		.optional(),
});

export type AgentMessageRequest = z.infer<typeof AgentMessageRequestSchema>;

// --- Manifest ---

// The generated block appended to a user message so the agent can discover
// resolved workspace paths. Built-in transcript renderers strip it again.
const MANIFEST_OPEN = "<pocketcoder-attachments>";
const MANIFEST_CLOSE = "</pocketcoder-attachments>";

export function attachmentManifest(descriptors: AttachmentDescriptor[]): string {
	return `${MANIFEST_OPEN}\n${JSON.stringify(descriptors, null, 2)}\n${MANIFEST_CLOSE}`;
}

export function splitAttachmentManifest(content: string): {
	text: string;
	attachments: AttachmentDescriptor[] | null;
} {
	const open = content.lastIndexOf(MANIFEST_OPEN);
	if (open < 0 || !content.trimEnd().endsWith(MANIFEST_CLOSE)) {
		return { text: content, attachments: null };
	}
	const close = content.lastIndexOf(MANIFEST_CLOSE);
	const parsed = z
		.array(AttachmentDescriptorSchema)
		.safeParse(safeJson(content.slice(open + MANIFEST_OPEN.length, close)));
	if (!parsed.success) return { text: content, attachments: null };
	return { text: content.slice(0, open).trimEnd(), attachments: parsed.data };
}

function safeJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

// --- Protocol v3 frame payloads ---

export const AttachmentStartPayload = z.object({
	operation_id: z.uuid(),
	attachment_id: z.uuid(),
	name: z.string().min(1).max(255),
	media_type: AttachmentMediaTypeSchema,
	size_bytes: z.number().int().min(0).max(ATTACHMENT_MAX_FILE_BYTES),
});

export const AttachmentChunkPayload = z.object({
	operation_id: z.uuid(),
	seq: z.number().int().nonnegative(),
	content_b64: z.string().max(Math.ceil(ATTACHMENT_CHUNK_BYTES / 3) * 4 + 4),
});

export const AttachmentFinishPayload = z.object({
	operation_id: z.uuid(),
});

export const AttachmentAbortPayload = z.object({
	operation_id: z.uuid(),
	reason: z.string().max(512),
});

export const AttachmentResolvePayload = z.object({
	operation_id: z.uuid(),
	attachment_ids: z.array(z.uuid()).min(1).max(ATTACHMENT_MAX_MESSAGE_IDS),
});

export const AttachmentAckPayload = z.object({
	operation_id: z.uuid(),
	seq: z.number().int().nonnegative(),
	received_bytes: z.number().int().nonnegative(),
});

export const ATTACHMENT_FAILURE_CODES = [
	"invalid",
	"too_large",
	"sequence",
	"io",
	"interrupted",
] as const;

export const AttachmentResultPayload = z.object({
	operation_id: z.uuid(),
	status: z.enum(["created", "existing", "conflict", "failed"]),
	descriptor: AttachmentDescriptorSchema.optional(),
	failure_code: z.enum(ATTACHMENT_FAILURE_CODES).optional(),
	detail: z.string().max(512).optional(),
});

export const AttachmentResolvedPayload = z.object({
	operation_id: z.uuid(),
	descriptors: z.array(AttachmentDescriptorSchema).optional(),
	missing_id: z.uuid().optional(),
});

export type AttachmentStart = z.infer<typeof AttachmentStartPayload>;
export type AttachmentChunk = z.infer<typeof AttachmentChunkPayload>;
export type AttachmentAck = z.infer<typeof AttachmentAckPayload>;
export type AttachmentResult = z.infer<typeof AttachmentResultPayload>;
export type AttachmentResolved = z.infer<typeof AttachmentResolvedPayload>;
