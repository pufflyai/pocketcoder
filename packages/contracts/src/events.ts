import { z } from "zod";
import { WORKSPACE_STATES, type WorkspaceState } from "./workspace";

// Signed lifecycle events delivered at least once from the outbox. Consumers
// verify the HMAC signature, deduplicate by event ID, and independently poll
// nonterminal workspaces for convergence.

export const EVENT_TYPES = WORKSPACE_STATES.map((s) => `workspace.${s}` as const);

export type EventType =
	| `workspace.${WorkspaceState}`
	| "workspace.output_published"
	| "workspace.restore_queued"
	| "checkpoint.creating"
	| "checkpoint.ready"
	| "checkpoint.failed"
	| "checkpoint.deleting"
	| "checkpoint.deleted";

export const EventEnvelopeSchema = z.object({
	id: z.uuid(),
	type: z.string(),
	occurred_at: z.iso.datetime(),
	workspace: z.object({
		id: z.uuid(),
		external_id: z.string(),
		state: z.enum(WORKSPACE_STATES),
		reason_code: z.string().nullable(),
		template: z.object({
			name: z.string(),
			version: z.string(),
			digest: z.string(),
		}),
		origin_workspace_id: z.uuid().nullable(),
		restored_from_checkpoint_id: z.uuid().nullable(),
		latest_checkpoint_id: z.uuid().nullable(),
		outputs: z.record(z.string(), z.unknown()),
	}),
});

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

export const EVENT_HEADER_ID = "X-Pocketcoder-Event-ID";
export const EVENT_HEADER_TIMESTAMP = "X-Pocketcoder-Timestamp";
export const EVENT_HEADER_SIGNATURE = "X-Pocketcoder-Signature";
