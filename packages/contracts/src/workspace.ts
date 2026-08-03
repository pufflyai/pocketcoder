import { z } from "zod";
import {
	CONVERSATION_RESTORE_CAPABILITIES,
	ResolvedSourceSchema,
	SourceDescriptorSchema,
} from "./persistence";

// Workspace lifecycle. A workspace is one isolated coding-agent session
// created from a template snapshot. Terminal states never reopen.

export const WORKSPACE_STATES = [
	"queued",
	"provisioning",
	"connected",
	"ready",
	"preserving",
	"terminating",
	"succeeded",
	"failed",
	"canceled",
	"expired",
	"preserved",
] as const;

export type WorkspaceState = (typeof WORKSPACE_STATES)[number];

export const TERMINAL_STATES: readonly WorkspaceState[] = [
	"succeeded",
	"failed",
	"canceled",
	"expired",
	"preserved",
];

export function isTerminal(state: WorkspaceState): boolean {
	return TERMINAL_STATES.includes(state);
}

const TRANSITIONS: Record<WorkspaceState, readonly WorkspaceState[]> = {
	queued: ["provisioning", "canceled", "expired"],
	// provisioning -> queued is the bounded infrastructure-launch retry and is
	// only legal before a provider object exists (enforced by the scheduler).
	provisioning: ["connected", "queued", "terminating", "failed", "canceled", "expired"],
	connected: ["ready", "preserving", "terminating", "failed", "canceled", "expired"],
	ready: ["preserving", "terminating", "succeeded", "failed", "canceled", "expired"],
	preserving: ["preserved", "failed"],
	terminating: ["succeeded", "failed", "canceled", "expired"],
	succeeded: [],
	failed: [],
	canceled: [],
	expired: [],
	preserved: [],
};

export function canTransition(from: WorkspaceState, to: WorkspaceState): boolean {
	return TRANSITIONS[from].includes(to);
}

export const REASON_CODES = [
	"child_exit_success",
	"child_exit_failure",
	"setup_failed",
	"bootstrap_failed",
	"registration_timeout",
	"health_failed",
	"child_crash",
	"provider_lost",
	"disconnect_timeout",
	"canceled_by_caller",
	"deadline_expired",
	"idle_expired",
	"queue_timeout",
	"launch_failed",
	"preserve_requested",
	"preserved_by_policy",
	"checkpoint_created",
	"checkpoint_failed",
	"checkpoint_corrupt",
	"checkpoint_quota_exceeded",
	"checkpoint_storage_lost",
	"restore_requested",
	"restore_failed",
	"image_unavailable",
	"source_resolution_failed",
	"secret_resolution_failed",
	"operation_conflict",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

export const AGENT_STATES = ["unknown", "running", "stable"] as const;
export type AgentState = (typeof AGENT_STATES)[number];

// REST request/response schemas.

export const WorkspaceCreateRequestSchema = z.object({
	external_id: z.string().min(1).max(256),
	template: z.object({
		name: z.string().min(1).max(64),
		version: z.string().max(64).optional(),
	}),
	launch_input: z.record(z.string(), z.unknown()).optional(),
	source: SourceDescriptorSchema.optional(),
	metadata: z.record(z.string().max(64), z.string().max(512)).optional(),
});

export type WorkspaceCreateRequest = z.infer<typeof WorkspaceCreateRequestSchema>;

export const TemplateRefSchema = z.object({
	name: z.string(),
	version: z.string(),
	digest: z.string(),
});

export const WorkspaceResourceSchema = z.object({
	id: z.uuid(),
	external_id: z.string(),
	template: TemplateRefSchema,
	state: z.enum(WORKSPACE_STATES),
	reason_code: z.enum(REASON_CODES).nullable(),
	agent_state: z.enum(AGENT_STATES),
	change_cursor: z.number().int().nonnegative(),
	provider_kind: z.string().nullable(),
	health: z.record(z.string(), z.string()),
	created_at: z.iso.datetime(),
	updated_at: z.iso.datetime(),
	connected_at: z.iso.datetime().nullable(),
	ready_at: z.iso.datetime().nullable(),
	deadline_at: z.iso.datetime(),
	terminal_at: z.iso.datetime().nullable(),
	metadata: z.record(z.string(), z.string()),
	origin_workspace_id: z.uuid().nullable(),
	restored_from_checkpoint_id: z.uuid().nullable(),
	source: SourceDescriptorSchema.extend({
		requested_revision: z.string(),
		resolved_commit: ResolvedSourceSchema.shape.resolved_commit.nullable(),
	})
		.omit({ revision: true })
		.nullable(),
	persistence: z.object({
		enabled: z.boolean(),
		conversation_restore: z.enum(CONVERSATION_RESTORE_CAPABILITIES),
		conversation_resume: z.object({
			status: z.enum(["supported", "unsupported", "unknown"]),
			reason: z.enum(["filesystem_only", "capability_unknown"]).nullable(),
		}),
		latest_checkpoint_id: z.uuid().nullable(),
	}),
	outputs: z.record(z.string(), z.unknown()),
	failure: z
		.object({
			reason_code: z.enum(REASON_CODES),
			log_tail: z.string(),
			log_tail_truncated: z.boolean(),
			last_log_seq: z.number().int().nonnegative().nullable(),
		})
		.nullable(),
});

export type WorkspaceResource = z.infer<typeof WorkspaceResourceSchema>;

export const WorkspaceCancelRequestSchema = z.object({
	reason: z.string().max(512).optional(),
});

export const WorkspaceListQuerySchema = z.object({
	external_id: z.string().optional(),
	state: z.enum(WORKSPACE_STATES).optional(),
	template: z.string().optional(),
	metadata: z.string().max(4096).optional(),
	created_after: z.iso.datetime().optional(),
	created_before: z.iso.datetime().optional(),
	limit: z.coerce.number().int().positive().max(200).default(50),
	cursor: z.string().optional(),
});

export const TemplateListItemSchema = z.object({
	name: z.string(),
	version: z.string(),
	digest: z.string(),
	description: z.string().optional(),
	status: z.enum(["active", "available", "retired"]),
});

export type TemplateListItem = z.infer<typeof TemplateListItemSchema>;
