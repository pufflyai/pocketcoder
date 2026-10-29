import { z } from "zod";

// Producer-defined codes. Consumers own their meaning; PocketCoder only keeps them.
const ProducerCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

export const ConversationFactSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("intermediate") }),
  z.object({ type: z.literal("final_response") }),
  z.object({ type: z.literal("tool_only") }),
  z.object({
    type: z.literal("activity_started"),
    activity_id: z.uuid(),
    kind: z.enum(["tool", "attachment", "workspace", "retrieval"]),
    label: z.string().min(1).max(160),
    started_at: z.iso.datetime().nullable(),
    action: ProducerCodeSchema.optional(),
    subject: ProducerCodeSchema.optional(),
  }),
  z.object({
    type: z.literal("activity_finished"),
    activity_id: z.uuid(),
    ended_at: z.iso.datetime().nullable(),
    outcome: z.enum(["completed", "failed", "interrupted", "canceled"]),
  }),
  z.object({
    type: z.literal("turn_terminal"),
    outcome: z.enum(["completed", "failed", "interrupted", "canceled", "lost"]),
    reason: ProducerCodeSchema.optional(),
  }),
]);
export type ConversationFact = z.infer<typeof ConversationFactSchema>;
