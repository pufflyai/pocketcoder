import { z } from "zod";
import { JsonValueSchema } from "../common/json-value";

const text = z.string().max(256 * 1024);
const payload = JsonValueSchema.refine(
  (value) => new TextEncoder().encode(JSON.stringify(value)).length <= 256 * 1024,
  "Session part payload exceeds 256 KiB",
);

export const ConversationPartSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text }),
  z.strictObject({
    type: z.literal("tool"),
    call_id: z.string().min(1).max(256),
    name: z.string().min(1).max(128),
    status: z.enum(["pending", "running", "completed", "failed", "canceled"]),
    input: payload,
    output: payload.optional(),
    output_text: text.optional(),
    started_at: z.iso.datetime().nullable().optional(),
    ended_at: z.iso.datetime().nullable().optional(),
  }),
  z.strictObject({
    type: z.literal("error"),
    code: z.string().min(1).max(128),
    message: text,
  }),
  z.strictObject({
    type: z.literal("file"),
    file_id: z.uuid(),
    name: z.string().min(1).max(512),
    media_type: z.string().min(1).max(256),
    size_bytes: z.number().int().nonnegative(),
  }),
]);
export type ConversationPart = z.infer<typeof ConversationPartSchema>;
