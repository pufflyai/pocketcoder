import { z } from "zod";
import { CursorPageSchema, CursorQuerySchema } from "./pagination";

export const TERMINAL_CHUNK_BYTES = 32 * 1024;
export const TERMINAL_REPLAY_BUFFER_BYTES = 64 * 1024;
export const TERMINAL_MIN_PROTOCOL_VERSION = 4;

function base64Schema(maxBytes: number) {
  return z
    .string()
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
    .refine((value) => {
      const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
      return (value.length / 4) * 3 - padding <= maxBytes;
    }, `decoded payload must not exceed ${maxBytes} bytes`);
}

const TerminalChunkSchema = base64Schema(TERMINAL_CHUNK_BYTES);
const TerminalReplaySchema = base64Schema(TERMINAL_REPLAY_BUFFER_BYTES);
const TerminalSizeSchema = z.number().int().min(1).max(1000);

export const TerminalOpenPayload = z.object({
  session_id: z.uuid(),
  rows: TerminalSizeSchema,
  cols: TerminalSizeSchema,
  reattach: z.boolean(),
});

export const TerminalInputPayload = z.object({
  session_id: z.uuid(),
  data_b64: TerminalChunkSchema,
});

export const TerminalResizePayload = z.object({
  session_id: z.uuid(),
  rows: TerminalSizeSchema,
  cols: TerminalSizeSchema,
});

export const TerminalClosePayload = z.object({
  session_id: z.uuid(),
  reason: z.enum(["checkpoint", "workspace_ended", "closed"]),
});

export const TerminalOpenedPayload = z.object({
  session_id: z.uuid(),
  replay_b64: TerminalReplaySchema.optional(),
});

export const TerminalOutputPayload = z.object({
  session_id: z.uuid(),
  data_b64: TerminalChunkSchema,
});

export const TerminalClosedPayload = z.object({
  session_id: z.uuid(),
  reason: z.enum(["exit", "idle", "checkpoint", "workspace_ended", "error", "closed"]),
  exit_code: z.number().int().nullable().optional(),
  detail: z.string().max(512).optional(),
});

export const ClientTerminalMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data_b64: TerminalChunkSchema }),
  z.object({ type: z.literal("resize"), rows: TerminalSizeSchema, cols: TerminalSizeSchema }),
]);

export const ServerTerminalMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("opened"),
    session_id: z.uuid(),
    replay_b64: TerminalReplaySchema.optional(),
  }),
  z.object({ type: z.literal("output"), data_b64: TerminalChunkSchema }),
  z.object({
    type: z.literal("closed"),
    reason: z.enum(["exit", "idle", "checkpoint", "workspace_ended", "agent_detached"]),
    exit_code: z.number().int().nullable().optional(),
  }),
  z.object({ type: z.literal("status"), state: z.enum(["reconnecting", "resumed"]) }),
]);

export const TERMINAL_CLOSE_REASONS = [
  "exit",
  "idle",
  "checkpoint",
  "workspace_ended",
  "agent_detached",
  "client_closed",
] as const;

export const TerminalSessionSchema = z.object({
  session_id: z.uuid(),
  workspace_id: z.uuid(),
  key_id: z.uuid(),
  opened_at: z.iso.datetime(),
  closed_at: z.iso.datetime().nullable(),
  duration_ms: z.number().int().nonnegative().nullable(),
  close_reason: z.enum(TERMINAL_CLOSE_REASONS).nullable(),
  exit_code: z.number().int().nullable(),
  bytes_in: z.number().int().nonnegative(),
  bytes_out: z.number().int().nonnegative(),
});

export const TerminalSessionListQuerySchema = CursorQuerySchema(200, 50);
export const TerminalSessionPageSchema = CursorPageSchema(TerminalSessionSchema);

export type TerminalOpen = z.infer<typeof TerminalOpenPayload>;
export type TerminalInput = z.infer<typeof TerminalInputPayload>;
export type TerminalResize = z.infer<typeof TerminalResizePayload>;
export type TerminalClose = z.infer<typeof TerminalClosePayload>;
export type TerminalOpened = z.infer<typeof TerminalOpenedPayload>;
export type TerminalOutput = z.infer<typeof TerminalOutputPayload>;
export type TerminalClosed = z.infer<typeof TerminalClosedPayload>;
export type ClientTerminalMessage = z.infer<typeof ClientTerminalMessageSchema>;
export type ServerTerminalMessage = z.infer<typeof ServerTerminalMessageSchema>;
export type TerminalCloseReason = (typeof TERMINAL_CLOSE_REASONS)[number];
export type TerminalSession = z.infer<typeof TerminalSessionSchema>;
