import { z } from "zod";
import { ConversationResumeOutcomeSchema } from "./conversation";
import { CursorPageSchema, CursorQuerySchema } from "./pagination";
import {
	CHECKPOINT_STATES,
	CheckpointResourceSchema,
	OperationResourceSchema,
} from "./persistence";
import { TemplateListItemSchema, WorkspaceResourceSchema } from "./workspace";

export const TemplatePageSchema = CursorPageSchema(TemplateListItemSchema);
export const TemplateListQuerySchema = CursorQuerySchema(200, 100);
export const CheckpointPageSchema = CursorPageSchema(CheckpointResourceSchema);
export const CheckpointListQuerySchema = CursorQuerySchema(200, 50).extend({
	state: z.enum(CHECKPOINT_STATES).optional(),
});

export const WorkspaceChangeSchema = z.object({
	cursor: z.number().int().nonnegative(),
	changed: z.boolean(),
	workspace: WorkspaceResourceSchema,
});

export const PreserveResponseSchema = z.object({
	workspace: WorkspaceResourceSchema,
	checkpoint: CheckpointResourceSchema,
	operation: OperationResourceSchema,
});

export const RestoreResponseSchema = z.object({
	workspace: WorkspaceResourceSchema,
	operation: OperationResourceSchema,
});

export const ResumeResponseSchema = RestoreResponseSchema.extend({
	resume: ConversationResumeOutcomeSchema,
});

export const OutputResourceSchema = z.object({
	seq: z.number().int().positive(),
	name: z.string(),
	value: z.unknown(),
	occurred_at: z.iso.datetime(),
});

export const OutputPageSchema = CursorPageSchema(OutputResourceSchema);
export const OutputListQuerySchema = CursorQuerySchema(1000, 200);
export type OutputResource = z.infer<typeof OutputResourceSchema>;

export const WarmPoolInventorySchema = z.object({
	items: z.array(
		z.object({
			template: z.string(),
			version: z.string(),
			template_digest: z.string(),
			driver: z.string(),
			desired: z.number().int().nonnegative(),
			counts: z.record(z.string(), z.number().int().nonnegative()),
			oldest_ready_age_ms: z.number().nonnegative().nullable(),
		}),
	),
	metrics: z.record(z.string(), z.number()),
});

export const StorageInventorySchema = z.object({
	backend: z.string(),
	storage_count: z.number().int().nonnegative(),
	checkpoint_count: z.number().int().nonnegative(),
	unknown_storage: z.array(z.string()),
	unknown_checkpoints: z.array(z.string()),
});

export const StoragePruneResultSchema = z.object({
	deleted: z.number().int().nonnegative(),
	skipped: z.number().int().nonnegative(),
	transcripts_deleted: z.number().int().nonnegative(),
});
