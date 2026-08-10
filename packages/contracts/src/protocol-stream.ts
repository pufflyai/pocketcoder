import { z } from "zod";

export const STREAMING_MIN_PROTOCOL_VERSION = 5;
export const PROXY_STREAM_CHUNK_BYTES = 65_536;

export const ProxyStreamStartPayload = z.object({
  request_id: z.uuid(),
  status: z.number().int().min(100).max(599),
  headers: z.record(z.string(), z.string()),
});

export const ProxyStreamChunkPayload = z.object({
  request_id: z.uuid(),
  seq: z.number().int().nonnegative(),
  content_b64: z.string().max(87_400),
});

export const ProxyStreamEndPayload = z.object({
  request_id: z.uuid(),
  error_code: z.enum(["unreachable", "deadline", "too_large"]).optional(),
});

export const ProxyStreamAckPayload = z.object({
  request_id: z.uuid(),
  seq: z.number().int().nonnegative(),
});

export const PROXY_STREAM_CANCEL_REASONS = [
  "downstream_closed",
  "deadline",
  "too_large",
  "workspace_disconnected",
] as const;

export const ProxyStreamCancelPayload = z.object({
  request_id: z.uuid(),
  reason: z.enum(PROXY_STREAM_CANCEL_REASONS),
});

export type ProxyStreamStart = z.infer<typeof ProxyStreamStartPayload>;
export type ProxyStreamChunk = z.infer<typeof ProxyStreamChunkPayload>;
export type ProxyStreamEnd = z.infer<typeof ProxyStreamEndPayload>;
export type ProxyStreamAck = z.infer<typeof ProxyStreamAckPayload>;
export type ProxyStreamCancel = z.infer<typeof ProxyStreamCancelPayload>;
