import { z } from "zod";

// Workspace lifecycle. A workspace is one isolated coding-agent session
// created from a template snapshot. Terminal states never reopen.

export const WORKSPACE_STATES = [
	"queued",
	"provisioning",
	"connected",
	"ready",
	"terminating",
	"succeeded",
	"failed",
	"canceled",
	"expired",
] as const;

export type WorkspaceState = (typeof WORKSPACE_STATES)[number];

export const TERMINAL_STATES: readonly WorkspaceState[] = [
	"succeeded",
	"failed",
	"canceled",
	"expired",
];

export function isTerminal(state: WorkspaceState): boolean {
	return TERMINAL_STATES.includes(state);
}

const TRANSITIONS: Record<WorkspaceState, readonly WorkspaceState[]> = {
	queued: ["provisioning", "canceled", "expired"],
	// provisioning -> queued is the bounded infrastructure-launch retry and is
	// only legal before a provider object exists (enforced by the scheduler).
	provisioning: ["connected", "queued", "terminating", "failed", "canceled", "expired"],
	connected: ["ready", "terminating", "failed", "canceled", "expired"],
	ready: ["terminating", "succeeded", "failed", "canceled", "expired"],
	terminating: ["succeeded", "failed", "canceled", "expired"],
	succeeded: [],
	failed: [],
	canceled: [],
	expired: [],
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
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

// REST request/response schemas.

export const WorkspaceCreateRequestSchema = z.object({
	external_id: z.string().min(1).max(256),
	template: z.object({
		name: z.string().min(1).max(64),
		version: z.string().max(64).optional(),
	}),
	launch_input: z.record(z.string(), z.unknown()).optional(),
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
	provider_kind: z.string().nullable(),
	health: z.record(z.string(), z.string()),
	created_at: z.iso.datetime(),
	updated_at: z.iso.datetime(),
	connected_at: z.iso.datetime().nullable(),
	ready_at: z.iso.datetime().nullable(),
	deadline_at: z.iso.datetime(),
	terminal_at: z.iso.datetime().nullable(),
	metadata: z.record(z.string(), z.string()),
});

export type WorkspaceResource = z.infer<typeof WorkspaceResourceSchema>;

export const WorkspaceCancelRequestSchema = z.object({
	reason: z.string().max(512).optional(),
});

export const WorkspaceListQuerySchema = z.object({
	external_id: z.string().optional(),
	state: z.enum(WORKSPACE_STATES).optional(),
	template: z.string().optional(),
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
