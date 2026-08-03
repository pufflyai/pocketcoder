import { z } from "zod";

export const CONVERSATION_ROLES = ["user", "assistant", "system", "tool"] as const;
export type ConversationRole = (typeof CONVERSATION_ROLES)[number];

export const ConversationMetadataSchema = z
	.record(z.string().min(1).max(64), z.string().max(512))
	.refine((value) => Object.keys(value).length <= 32, "conversation metadata has at most 32 keys");

export const ConversationMessageInputSchema = z.object({
	message_id: z.string().min(1).max(256),
	role: z.enum(CONVERSATION_ROLES),
	content: z.string().max(256 * 1024),
	occurred_at: z.iso.datetime(),
	metadata: ConversationMetadataSchema.default({}),
});
export type ConversationMessageInput = z.infer<typeof ConversationMessageInputSchema>;

export const ConversationMessageResourceSchema = ConversationMessageInputSchema.extend({
	seq: z.number().int().positive(),
});
export type ConversationMessageResource = z.infer<typeof ConversationMessageResourceSchema>;

export const ConversationListQuerySchema = z.object({
	after: z.coerce.number().int().nonnegative().default(0),
	limit: z.coerce.number().int().positive().max(200).default(100),
});

export const CONVERSATION_RESUME_REASONS = ["filesystem_only", "capability_unknown"] as const;
export type ConversationResumeReason = (typeof CONVERSATION_RESUME_REASONS)[number];

export const ConversationResumeOutcomeSchema = z.object({
	status: z.literal("supported"),
	reason: z.null(),
	source_workspace_id: z.uuid(),
	checkpoint_id: z.uuid(),
});
