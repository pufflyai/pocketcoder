import { z } from "zod";

// Legacy attachment frames and transcript descriptors. Canonical uploads now use
// controller-owned storage and InputObjectReference; these frames cannot publish inputs.

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

export const ATTACHMENT_FAILURE_CODES = ["invalid", "too_large", "sequence", "io", "interrupted"] as const;

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
