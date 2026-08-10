import {
  AGENT_STATES,
  LAUNCH_MODES,
  NETWORK_STATES,
  REASON_CODES,
  TERMINAL_STATES,
  WORKSPACE_STATES,
} from "@pstdio/pocketcoder-contracts";
import { WARM_POOL_RUNTIME_STATES } from "@pstdio/pocketcoder-runtime-contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  bytea,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { machineKeys, principals, templates } from "./access";
import { sqlValues, timestamptz } from "./columns";

const terminalStates = sqlValues(TERMINAL_STATES);

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
    networkState: text("network_state").notNull().default("disabled"),
    networkEventSeq: bigint("network_event_seq", { mode: "number" }).notNull().default(0),
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
    check("workspaces_state_check", sql`${table.state} IN ${sqlValues(WORKSPACE_STATES)}`),
    check(
      "workspaces_reason_code_check",
      sql`${table.reasonCode} IS NULL OR ${table.reasonCode} IN ${sqlValues(REASON_CODES)}`,
    ),
    check("workspaces_agent_state_check", sql`${table.agentState} IN ${sqlValues(AGENT_STATES)}`),
    check(
      "workspaces_network_state_check",
      sql`${table.networkState} IN ${sqlValues(NETWORK_STATES)}`,
    ),
    check(
      "workspaces_terminal_intent_check",
      sql`${table.terminalIntent} IS NULL OR ${table.terminalIntent} IN ${sqlValues(WORKSPACE_STATES)}`,
    ),
    check(
      "workspaces_provisioning_mode_check",
      sql`${table.provisioningMode} IS NULL OR ${table.provisioningMode} IN ('cold', 'warm')`,
    ),
    check("workspaces_launch_mode_check", sql`${table.launchMode} IN ${sqlValues(LAUNCH_MODES)}`),
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

export const workspaceNetworkEvents = pgTable(
  "workspace_network_events",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    sourceSessionId: uuid("source_session_id").notNull(),
    sourceSeq: bigint("source_seq", { mode: "number" }).notNull(),
    occurredAt: timestamptz("occurred_at").notNull(),
    decision: text("decision").notNull(),
    transport: text("transport").notNull(),
    host: text("host").notNull(),
    port: integer("port").notNull(),
    method: text("method"),
    path: text("path"),
    matchedRule: text("matched_rule"),
    reason: text("reason").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.seq] }),
    unique().on(table.workspaceId, table.sourceSessionId, table.sourceSeq),
    index("workspace_network_events_page").on(table.workspaceId, table.seq),
  ],
);

export const workspaceTerminalSessions = pgTable(
  "workspace_terminal_sessions",
  {
    sessionId: uuid("session_id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    keyId: uuid("key_id")
      .notNull()
      .references(() => machineKeys.id),
    openedAt: timestamptz("opened_at").notNull(),
    closedAt: timestamptz("closed_at"),
    closeReason: text("close_reason"),
    exitCode: integer("exit_code"),
    bytesIn: bigint("bytes_in", { mode: "number" }).notNull().default(0),
    bytesOut: bigint("bytes_out", { mode: "number" }).notNull().default(0),
  },
  (table) => [
    check(
      "workspace_terminal_sessions_close_reason_check",
      sql`${table.closeReason} IS NULL OR ${table.closeReason} IN ${sqlValues([
        "exit",
        "idle",
        "checkpoint",
        "workspace_ended",
        "agent_detached",
        "client_closed",
      ])}`,
    ),
    index("workspace_terminal_sessions_page").on(
      table.workspaceId,
      table.openedAt,
      table.sessionId,
    ),
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
    check(
      "warm_pool_runtimes_state_check",
      sql`${table.state} IN ${sqlValues(WARM_POOL_RUNTIME_STATES)}`,
    ),
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
