import { z } from "zod";
import { isDuration } from "./duration";

const DurationValueSchema = z
	.string()
	.refine(isDuration, { message: "expected a duration like 15s, 20m, or 2h" });

export const LAUNCH_MODES = ["create", "restore"] as const;
export type LaunchMode = (typeof LAUNCH_MODES)[number];

export const CONVERSATION_RESTORE_CAPABILITIES = [
	"supported",
	"filesystem_only",
	"unknown",
] as const;
export type ConversationRestoreCapability = (typeof CONVERSATION_RESTORE_CAPABILITIES)[number];

export const SourceDescriptorSchema = z.object({
	kind: z.literal("git"),
	repository: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/),
	revision: z
		.string()
		.min(1)
		.max(256)
		.refine(
			(value) =>
				!value.startsWith("-") &&
				!value.startsWith("/") &&
				!value.endsWith("/") &&
				!value.endsWith(".") &&
				!value.endsWith(".lock") &&
				value !== "@" &&
				!value.includes("..") &&
				!value.includes("//") &&
				!value.includes("@{") &&
				!/[~^:?*[\]\\\s]/u.test(value) &&
				[...value].every((character) => {
					const code = character.codePointAt(0) ?? 0;
					return code >= 32 && code !== 127;
				}),
			{ message: "revision is not a safe branch, tag, or commit name" },
		),
});
export type SourceDescriptor = z.infer<typeof SourceDescriptorSchema>;

export const ResolvedSourceSchema = z.object({
	kind: z.literal("git"),
	repository: z.string().min(1).max(64),
	requested_revision: z.string().min(1).max(256),
	resolved_commit: z.string().regex(/^[0-9a-f]{40,64}$/),
});
export type ResolvedSource = z.infer<typeof ResolvedSourceSchema>;

export const PersistenceMountSchema = z.object({
	name: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/),
	target: z.string().min(1),
	maxBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	maxFiles: z.number().int().positive().max(10_000_000),
});
export type PersistenceMount = z.infer<typeof PersistenceMountSchema>;

export const CheckpointPolicySchema = z.object({
	onIdle: z.enum(["preserve", "destroy"]).default("destroy"),
	onDeadline: z.enum(["preserve", "destroy"]).default("destroy"),
	onCleanExit: z.enum(["preserve", "destroy"]).default("destroy"),
	onFailure: z.enum(["preserve", "retain-for-recovery", "destroy"]).default("destroy"),
	retention: DurationValueSchema.default("168h"),
});

export const PersistenceSpecSchema = z.object({
	mounts: z.array(PersistenceMountSchema).max(16).default([]),
	conversationRestore: z.enum(CONVERSATION_RESTORE_CAPABILITIES).default("filesystem_only"),
	conversationRetention: DurationValueSchema.default("168h"),
	sessionCompatibility: z.string().min(1).max(128).optional(),
	checkpoint: CheckpointPolicySchema.prefault({}),
});
export type PersistenceSpec = z.infer<typeof PersistenceSpecSchema>;

export const OutputDeclarationSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("gitSha") }),
	z.object({
		type: z.literal("string"),
		maxLength: z.number().int().positive().max(4096).default(512),
	}),
	z.object({
		type: z.literal("httpsUrl"),
		maxLength: z.number().int().positive().max(4096).default(2048),
	}),
]);
export type OutputDeclaration = z.infer<typeof OutputDeclarationSchema>;

export const CHECKPOINT_STATES = ["creating", "ready", "failed", "deleting", "deleted"] as const;
export type CheckpointState = (typeof CHECKPOINT_STATES)[number];

export const OPERATION_KINDS = ["preserve", "restore", "verify", "delete"] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

export const OPERATION_STATES = ["pending", "running", "succeeded", "failed"] as const;
export type OperationState = (typeof OPERATION_STATES)[number];

export const STORAGE_STATES = [
	"allocating",
	"ready",
	"snapshotting",
	"retained",
	"restoring",
	"deleting",
	"deleted",
	"lost",
	"quarantined",
] as const;
export type StorageState = (typeof STORAGE_STATES)[number];

export const CheckpointResourceSchema = z.object({
	id: z.uuid(),
	workspace_id: z.uuid(),
	state: z.enum(CHECKPOINT_STATES),
	reason_code: z.string().nullable(),
	template: z.object({
		name: z.string(),
		version: z.string(),
		digest: z.string(),
	}),
	manifest_digest: z.string().nullable(),
	logical_bytes: z.number().int().nonnegative().nullable(),
	stored_bytes: z.number().int().nonnegative().nullable(),
	file_count: z.number().int().nonnegative().nullable(),
	mounts: z.array(z.string()),
	conversation_restore: z.enum(CONVERSATION_RESTORE_CAPABILITIES),
	label: z.string().nullable(),
	created_at: z.iso.datetime(),
	ready_at: z.iso.datetime().nullable(),
	expires_at: z.iso.datetime().nullable(),
});
export type CheckpointResource = z.infer<typeof CheckpointResourceSchema>;

export const OperationResourceSchema = z.object({
	id: z.uuid(),
	kind: z.enum(OPERATION_KINDS),
	state: z.enum(OPERATION_STATES),
	workspace_id: z.uuid().nullable(),
	checkpoint_id: z.uuid().nullable(),
	result_workspace_id: z.uuid().nullable(),
	reason_code: z.string().nullable(),
	created_at: z.iso.datetime(),
	updated_at: z.iso.datetime(),
	completed_at: z.iso.datetime().nullable(),
});
export type OperationResource = z.infer<typeof OperationResourceSchema>;

export const PreserveRequestSchema = z.object({
	retention: DurationValueSchema.optional(),
	label: z.string().min(1).max(128).optional(),
});
export type PreserveRequest = z.infer<typeof PreserveRequestSchema>;

export const RestoreRequestSchema = z.object({
	external_id: z.string().min(1).max(256),
	metadata: z.record(z.string().max(64), z.string().max(512)).optional(),
});
export type RestoreRequest = z.infer<typeof RestoreRequestSchema>;

export const CheckpointManifestEntrySchema = z.object({
	path: z.string(),
	kind: z.enum(["directory", "file", "symlink"]),
	mode: z.number().int().nonnegative(),
	uid: z.number().int().nonnegative(),
	gid: z.number().int().nonnegative(),
	mtime_ns: z.string().regex(/^\d+$/),
	size: z.number().int().nonnegative(),
	digest: z.string().optional(),
	link_target: z.string().optional(),
});

export const CheckpointManifestSchema = z.object({
	format: z.literal("pocketcoder-checkpoint/v1"),
	checkpoint_id: z.uuid(),
	template_digest: z.string(),
	mounts: z.array(
		z.object({
			name: z.string(),
			entries: z.array(CheckpointManifestEntrySchema),
		}),
	),
	logical_bytes: z.number().int().nonnegative(),
	file_count: z.number().int().nonnegative(),
});
export type CheckpointManifest = z.infer<typeof CheckpointManifestSchema>;
