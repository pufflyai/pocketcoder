import { z } from "zod";
import { CursorPageSchema } from "../common/pagination";
import { ConversationMessageResourceSchema } from "./conversation";
import { ConversationProtocolSupportSchema, ConversationRequestIdentitySchema } from "./identity";

// How a stored record ended. Turns use their terminal outcome; `message` holds one message
// without identity; `legacy` holds history converted from releases before 0.9.
export const CONVERSATION_RECORD_STATUSES = [
  "completed",
  "failed",
  "interrupted",
  "canceled",
  "lost",
  "message",
  "legacy",
] as const;
export type ConversationRecordStatus = (typeof CONVERSATION_RECORD_STATUSES)[number];

export const ConversationActivitySchema = z.object({
  activity_id: z.uuid(),
  kind: z.string(),
  label: z.string(),
  action: z.string().nullable(),
  subject: z.string().nullable(),
  started_at: z.iso.datetime().nullable(),
  ended_at: z.iso.datetime().nullable(),
  outcome: z.string().nullable(),
});
export type ConversationActivity = z.infer<typeof ConversationActivitySchema>;

// One immutable JSON record. A conversation document is its records in order.
export const ConversationRecordDocumentSchema = z.object({
  schema: z.literal("pocketcoder.conversation-record/v1"),
  turn_id: z.uuid().nullable(),
  request: ConversationRequestIdentitySchema.nullable(),
  status: z.enum(CONVERSATION_RECORD_STATUSES),
  reason: z.string().nullable(),
  messages: z.array(ConversationMessageResourceSchema),
  activities: z.array(ConversationActivitySchema),
  final_response: z.string().nullable(),
  started_at: z.iso.datetime().nullable(),
  ended_at: z.iso.datetime().nullable(),
});
export type ConversationRecordDocument = z.infer<typeof ConversationRecordDocumentSchema>;

export const CONVERSATION_STATUSES = ["retained", "deleted", "expired"] as const;

export const ConversationSummarySchema = z.object({
  conversation_id: z.uuid().nullable(),
  workspace_id: z.uuid(),
  legacy: z.boolean(),
  status: z.enum(CONVERSATION_STATUSES),
  message_count: z.number().int().nonnegative(),
  turn_count: z.number().int().nonnegative(),
  last_activity_at: z.iso.datetime(),
  expires_at: z.iso.datetime().nullable(),
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

export const ConversationListSchema = z.object({ items: z.array(ConversationSummarySchema) });

export const ConversationDocumentPageSchema = CursorPageSchema(ConversationMessageResourceSchema).extend({
  conversation: ConversationSummarySchema,
  protocol: ConversationProtocolSupportSchema,
});

// Live tail events. `turn` carries the open turn so far; `committed` names the stored record.
export const ConversationLiveEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("turn"),
    conversation_id: z.uuid(),
    turn_id: z.uuid(),
    messages: z.array(ConversationMessageResourceSchema.omit({ seq: true })),
  }),
  z.object({
    type: z.literal("committed"),
    conversation_id: z.uuid().nullable(),
    turn_id: z.uuid().nullable(),
    status: z.enum(CONVERSATION_RECORD_STATUSES),
    last_seq: z.number().int().nonnegative(),
  }),
]);
export type ConversationLiveEvent = z.infer<typeof ConversationLiveEventSchema>;
