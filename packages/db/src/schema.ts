import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	bytea,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

// Drizzle owns the database shape and generated migrations. The tables are
// intentionally unqualified here because the runtime schema is configurable:
// migrations set search_path to the validated POCKETCODER_DATABASE_SCHEMA,
// while runtime queries continue to use fully qualified identifiers.

const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const terminalStates = sql`('succeeded', 'failed', 'canceled', 'expired', 'preserved')`;

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const templates = pgTable(
	"templates",
	{
		id: uuid("id").primaryKey(),
		name: text("name").notNull(),
		version: text("version").notNull(),
		digest: text("digest").notNull().unique(),
		description: text("description"),
		spec: jsonb("spec").$type<Record<string, unknown>>().notNull(),
		status: text("status").notNull(),
		createdAt: timestamptz("created_at").notNull(),
		retiredAt: timestamptz("retired_at"),
	},
	(table) => [unique().on(table.name, table.version)],
);

export const principals = pgTable("principals", {
	id: uuid("id").primaryKey(),
	name: text("name").notNull().unique(),
	scopes: text("scopes").array().notNull(),
	templateNames: text("template_names").array().notNull(),
	disabledAt: timestamptz("disabled_at"),
	createdAt: timestamptz("created_at").notNull(),
});

export const machineKeys = pgTable("machine_keys", {
	id: uuid("id").primaryKey(),
	principalId: uuid("principal_id")
		.notNull()
		.references(() => principals.id),
	secretDigest: bytea("secret_digest").notNull(),
	scopes: text("scopes").array().notNull(),
	createdAt: timestamptz("created_at").notNull(),
	expiresAt: timestamptz("expires_at"),
	revokedAt: timestamptz("revoked_at"),
	lastUsedAt: timestamptz("last_used_at"),
});

export const workspaces = pgTable(
	"workspaces",
	{
		id: uuid("id").primaryKey(),
		principalId: uuid("principal_id")
			.notNull()
			.references(() => principals.id),
		externalId: text("external_id").notNull(),
		idempotencyKey: text("idempotency_key").notNull(),
		requestDigest: text("request_digest").notNull(),
		templateId: uuid("template_id")
			.notNull()
			.references(() => templates.id),
		templateName: text("template_name").notNull(),
		templateVersion: text("template_version").notNull(),
		templateDigest: text("template_digest").notNull(),
		templateSnapshot: jsonb("template_snapshot").$type<Record<string, unknown>>().notNull(),
		state: text("state").notNull(),
		reasonCode: text("reason_code"),
		agentState: text("agent_state").notNull().default("unknown"),
		changeSeq: bigint("change_seq", { mode: "number" }).notNull().default(1),
		failureLogTail: text("failure_log_tail"),
		failureLogTailTruncated: boolean("failure_log_tail_truncated").notNull().default(false),
		failureLastLogSeq: bigint("failure_last_log_seq", { mode: "number" }),
		terminalIntent: text("terminal_intent"),
		launchInput: jsonb("launch_input").$type<Record<string, unknown>>(),
		providerKind: text("provider_kind"),
		providerRef: jsonb("provider_ref").$type<Record<string, unknown>>(),
		provisioningMode: text("provisioning_mode"),
		registrationDigest: bytea("registration_digest"),
		registrationExpiresAt: timestamptz("registration_expires_at"),
		reconnectDigest: bytea("reconnect_digest"),
		connectionEpoch: integer("connection_epoch").notNull().default(0),
		connectedAt: timestamptz("connected_at"),
		disconnectedAt: timestamptz("disconnected_at"),
		readyAt: timestamptz("ready_at"),
		lastActivityAt: timestamptz("last_activity_at"),
		launchAttempts: integer("launch_attempts").notNull().default(0),
		health: jsonb("health").$type<Record<string, unknown>>().notNull().default({}),
		metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
		deadlineAt: timestamptz("deadline_at").notNull(),
		createdAt: timestamptz("created_at").notNull(),
		updatedAt: timestamptz("updated_at").notNull(),
		terminalAt: timestamptz("terminal_at"),
		originWorkspaceId: uuid("origin_workspace_id"),
		restoredFromCheckpointId: uuid("restored_from_checkpoint_id"),
		sourceDescriptor: jsonb("source_descriptor").$type<Record<string, unknown>>(),
		resolvedSource: jsonb("resolved_source").$type<Record<string, unknown>>(),
		persistenceCapability: text("persistence_capability").notNull().default("filesystem_only"),
		latestCheckpointId: uuid("latest_checkpoint_id"),
		launchMode: text("launch_mode").notNull().default("create"),
		outputs: jsonb("outputs").$type<Record<string, unknown>>().notNull().default({}),
	},
	(table) => [
		unique().on(table.principalId, table.idempotencyKey),
		uniqueIndex("workspaces_principal_external_active")
			.on(table.principalId, table.externalId)
			.where(sql`${table.state} NOT IN ${terminalStates}`),
		index("workspaces_state_created").on(table.state, table.createdAt),
		index("workspaces_deadline")
			.on(table.deadlineAt)
			.where(sql`${table.state} NOT IN ${terminalStates}`),
	],
);

export const warmPoolRuntimes = pgTable(
	"warm_pool_runtimes",
	{
		id: uuid("id").primaryKey(),
		templateId: uuid("template_id")
			.notNull()
			.references(() => templates.id),
		templateName: text("template_name").notNull(),
		templateVersion: text("template_version").notNull(),
		templateDigest: text("template_digest").notNull(),
		driverKind: text("driver_kind").notNull(),
		eligibilityFingerprint: text("eligibility_fingerprint").notNull(),
		state: text("state").notNull(),
		providerRef: jsonb("provider_ref").$type<Record<string, unknown>>(),
		enrollmentDigest: bytea("enrollment_digest"),
		enrollmentExpiresAt: timestamptz("enrollment_expires_at"),
		workspaceId: uuid("workspace_id").references(() => workspaces.id),
		createdAt: timestamptz("created_at").notNull(),
		updatedAt: timestamptz("updated_at").notNull(),
		readyAt: timestamptz("ready_at"),
		leasedAt: timestamptz("leased_at"),
		failureCode: text("failure_code"),
	},
	(table) => [
		index("warm_pool_eligible").on(
			table.templateDigest,
			table.driverKind,
			table.eligibilityFingerprint,
			table.state,
			table.readyAt,
		),
		uniqueIndex("warm_pool_workspace_once").on(table.workspaceId),
	],
);

export const workspaceStorage = pgTable(
	"workspace_storage",
	{
		id: uuid("id").primaryKey(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id),
		principalId: uuid("principal_id")
			.notNull()
			.references(() => principals.id),
		providerKind: text("provider_kind").notNull(),
		providerRef: jsonb("provider_ref").$type<Record<string, unknown>>().notNull(),
		state: text("state").notNull(),
		mountManifest: jsonb("mount_manifest").$type<Record<string, unknown>[]>().notNull(),
		logicalBytes: bigint("logical_bytes", { mode: "number" }),
		fileCount: bigint("file_count", { mode: "number" }),
		retainedUntil: timestamptz("retained_until"),
		createdAt: timestamptz("created_at").notNull(),
		updatedAt: timestamptz("updated_at").notNull(),
		deletedAt: timestamptz("deleted_at"),
		lastErrorCode: text("last_error_code"),
	},
	(table) => [
		uniqueIndex("workspace_storage_one_live")
			.on(table.workspaceId)
			.where(sql`${table.state} NOT IN ('deleted', 'lost', 'quarantined')`),
		index("workspace_storage_gc").on(table.state, table.retainedUntil),
		index("workspace_storage_principal").on(table.principalId),
	],
);

export const workspaceCheckpoints = pgTable(
	"workspace_checkpoints",
	{
		id: uuid("id").primaryKey(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id),
		principalId: uuid("principal_id")
			.notNull()
			.references(() => principals.id),
		storageId: uuid("storage_id")
			.notNull()
			.references(() => workspaceStorage.id),
		parentCheckpointId: uuid("parent_checkpoint_id"),
		state: text("state").notNull(),
		reasonCode: text("reason_code"),
		providerKind: text("provider_kind").notNull(),
		providerRef: jsonb("provider_ref").$type<Record<string, unknown>>(),
		templateSnapshot: jsonb("template_snapshot").$type<Record<string, unknown>>().notNull(),
		templateDigest: text("template_digest").notNull(),
		sourceProvenance: jsonb("source_provenance").$type<Record<string, unknown>>(),
		manifest: jsonb("manifest").$type<Record<string, unknown>>(),
		manifestDigest: text("manifest_digest"),
		logicalBytes: bigint("logical_bytes", { mode: "number" }),
		storedBytes: bigint("stored_bytes", { mode: "number" }),
		fileCount: bigint("file_count", { mode: "number" }),
		conversationRestore: text("conversation_restore").notNull(),
		label: text("label"),
		createdAt: timestamptz("created_at").notNull(),
		updatedAt: timestamptz("updated_at").notNull(),
		readyAt: timestamptz("ready_at"),
		expiresAt: timestamptz("expires_at"),
		deletedAt: timestamptz("deleted_at"),
	},
	(table) => [
		index("workspace_checkpoints_principal_state").on(
			table.principalId,
			table.state,
			table.createdAt,
		),
		index("workspace_checkpoints_gc").on(table.state, table.expiresAt),
	],
);

export const workspaceOperations = pgTable(
	"workspace_operations",
	{
		id: uuid("id").primaryKey(),
		principalId: uuid("principal_id")
			.notNull()
			.references(() => principals.id),
		kind: text("kind").notNull(),
		state: text("state").notNull(),
		idempotencyKey: text("idempotency_key").notNull(),
		requestDigest: text("request_digest").notNull(),
		workspaceId: uuid("workspace_id").references(() => workspaces.id),
		checkpointId: uuid("checkpoint_id").references(() => workspaceCheckpoints.id),
		resultWorkspaceId: uuid("result_workspace_id").references(() => workspaces.id),
		reasonCode: text("reason_code"),
		attemptCount: integer("attempt_count").notNull().default(0),
		createdAt: timestamptz("created_at").notNull(),
		updatedAt: timestamptz("updated_at").notNull(),
		completedAt: timestamptz("completed_at"),
	},
	(table) => [
		unique().on(table.principalId, table.kind, table.idempotencyKey),
		index("workspace_operations_due").on(table.state, table.updatedAt),
	],
);

export const workspaceOutputs = pgTable(
	"workspace_outputs",
	{
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id),
		seq: bigint("seq", { mode: "bigint" }).notNull(),
		name: text("name").notNull(),
		value: jsonb("value").$type<unknown>().notNull(),
		occurredAt: timestamptz("occurred_at").notNull(),
	},
	(table) => [primaryKey({ columns: [table.workspaceId, table.seq] })],
);

export const workspaceConversations = pgTable("workspace_conversations", {
	workspaceId: uuid("workspace_id")
		.primaryKey()
		.references(() => workspaces.id),
	status: text("status").notNull(),
	expiresAt: timestamptz("expires_at"),
	deletedAt: timestamptz("deleted_at"),
	updatedAt: timestamptz("updated_at").notNull(),
});

export const workspaceConversationMessages = pgTable(
	"workspace_conversation_messages",
	{
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id),
		seq: bigint("seq", { mode: "bigint" }).notNull(),
		messageId: text("message_id").notNull(),
		role: text("role").notNull(),
		content: text("content").notNull(),
		occurredAt: timestamptz("occurred_at").notNull(),
		metadata: jsonb("metadata").$type<Record<string, string>>().notNull().default({}),
		createdAt: timestamptz("created_at").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.workspaceId, table.seq] }),
		unique().on(table.workspaceId, table.messageId),
	],
);

export const workspaceStateHistory = pgTable(
	"workspace_state_history",
	{
		id: uuid("id").primaryKey(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id),
		fromState: text("from_state"),
		toState: text("to_state").notNull(),
		reasonCode: text("reason_code"),
		occurredAt: timestamptz("occurred_at").notNull(),
	},
	(table) => [index("workspace_state_history_ws").on(table.workspaceId, table.occurredAt)],
);

export const workspaceLogs = pgTable(
	"workspace_logs",
	{
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id),
		seq: bigint("seq", { mode: "bigint" }).notNull(),
		stream: text("stream").notNull(),
		occurredAt: timestamptz("occurred_at").notNull(),
		content: bytea("content").notNull(),
	},
	(table) => [primaryKey({ columns: [table.workspaceId, table.seq] })],
);

export const eventOutbox = pgTable(
	"event_outbox",
	{
		id: uuid("id").primaryKey(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id),
		eventType: text("event_type").notNull(),
		payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
		occurredAt: timestamptz("occurred_at").notNull(),
		nextAttemptAt: timestamptz("next_attempt_at").notNull(),
		attemptCount: integer("attempt_count").notNull().default(0),
		deliveredAt: timestamptz("delivered_at"),
		lastErrorCode: text("last_error_code"),
	},
	(table) => [
		index("event_outbox_due").on(table.nextAttemptAt).where(sql`${table.deliveredAt} IS NULL`),
	],
);

export function assertValidSchema(schema: string): string {
	if (!SCHEMA_RE.test(schema)) {
		throw new Error(
			`invalid database schema name: ${JSON.stringify(schema)} (expected ${SCHEMA_RE})`,
		);
	}
	return schema;
}

export function qualify(schema: string, table: string): string {
	return `"${assertValidSchema(schema)}"."${table}"`;
}

// Stable signed 64-bit advisory-lock key derived from the configured schema,
// so concurrent migrators on the same schema serialize while different
// schemas do not contend.
export function advisoryLockKey(schema: string): bigint {
	const digest = createHash("sha256").update(`pocketcoder:${schema}`).digest();
	return BigInt.asIntN(64, digest.readBigUInt64BE(0));
}
