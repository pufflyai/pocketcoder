import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import {
	bigint,
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
const terminalStates = sql`('succeeded', 'failed', 'canceled', 'expired')`;

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
		terminalIntent: text("terminal_intent"),
		launchInput: jsonb("launch_input").$type<Record<string, unknown>>(),
		providerKind: text("provider_kind"),
		providerRef: jsonb("provider_ref").$type<Record<string, unknown>>(),
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
