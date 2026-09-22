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
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sqlValues, timestamptz } from "./columns";
import { structuredJson } from "./structured-json";

const terminalStates = sqlValues(TERMINAL_STATES);

import type { TerminalSessionRow, WarmPoolRuntimeRow, WorkspaceRow } from "@pstdio/pocketcoder-runtime-contracts";
import { type PgTableFn, pgTable } from "drizzle-orm/pg-core";
import type { createAccessTables } from "./access";

export function createWorkspaceTables(
  table: PgTableFn<string | undefined> = pgTable,
  { principals, machineKeys, templates }: ReturnType<typeof createAccessTables>,
) {
  const workspaces = table(
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
      templateSnapshot: structuredJson("template_snapshot")
        .$type<NonNullable<WorkspaceRow["templateSnapshot"]>>()
        .notNull(),
      state: text("state").$type<NonNullable<WorkspaceRow["state"]>>().notNull(),
      reasonCode: text("reason_code").$type<NonNullable<WorkspaceRow["reasonCode"]>>(),
      agentState: text("agent_state").$type<NonNullable<WorkspaceRow["agentState"]>>().notNull().default("unknown"),
      networkState: text("network_state")
        .$type<NonNullable<WorkspaceRow["networkState"]>>()
        .notNull()
        .default("disabled"),
      networkEventSeq: bigint("network_event_seq", { mode: "number" }).notNull().default(0),
      changeSeq: bigint("change_seq", { mode: "number" }).notNull().default(1),
      failureLogTail: text("failure_log_tail"),
      failureLogTailTruncated: boolean("failure_log_tail_truncated").notNull().default(false),
      failureLastLogSeq: bigint("failure_last_log_seq", { mode: "number" }),
      terminalIntent: text("terminal_intent").$type<NonNullable<WorkspaceRow["terminalIntent"]>>(),
      launchInput: structuredJson("launch_input").$type<NonNullable<WorkspaceRow["launchInput"]>>(),
      providerKind: text("provider_kind"),
      providerRef: structuredJson("provider_ref").$type<NonNullable<WorkspaceRow["providerRef"]>>(),
      provisioningMode: text("provisioning_mode").$type<NonNullable<WorkspaceRow["provisioningMode"]>>(),
      registrationDigest: bytea("registration_digest").$type<Uint8Array>(),
      registrationExpiresAt: timestamptz("registration_expires_at"),
      reconnectDigest: bytea("reconnect_digest").$type<Uint8Array>(),
      connectionEpoch: integer("connection_epoch").notNull().default(0),
      connectedAt: timestamptz("connected_at"),
      disconnectedAt: timestamptz("disconnected_at"),
      readyAt: timestamptz("ready_at"),
      lastActivityAt: timestamptz("last_activity_at"),
      launchAttempts: integer("launch_attempts").notNull().default(0),
      health: structuredJson("health").$type<NonNullable<WorkspaceRow["health"]>>().notNull().default({}),
      metadata: structuredJson("metadata").$type<NonNullable<WorkspaceRow["metadata"]>>().notNull().default({}),
      deadlineAt: timestamptz("deadline_at").notNull(),
      createdAt: timestamptz("created_at").notNull(),
      updatedAt: timestamptz("updated_at").notNull(),
      terminalAt: timestamptz("terminal_at"),
      purgeRequestedAt: timestamptz("purge_requested_at"),
      originWorkspaceId: uuid("origin_workspace_id"),
      restoredFromCheckpointId: uuid("restored_from_checkpoint_id"),
      sourceDescriptor: structuredJson("source_descriptor").$type<NonNullable<WorkspaceRow["sourceDescriptor"]>>(),
      resolvedSource: structuredJson("resolved_source").$type<NonNullable<WorkspaceRow["resolvedSource"]>>(),
      persistenceCapability: text("persistence_capability")
        .$type<NonNullable<WorkspaceRow["persistenceCapability"]>>()
        .notNull()
        .default("filesystem_only"),
      latestCheckpointId: uuid("latest_checkpoint_id"),
      launchMode: text("launch_mode").$type<NonNullable<WorkspaceRow["launchMode"]>>().notNull().default("create"),
      outputs: structuredJson("outputs").$type<NonNullable<WorkspaceRow["outputs"]>>().notNull().default({}),
    },
    (table) => [
      check("workspaces_state_check", sql`${table.state} IN ${sqlValues(WORKSPACE_STATES)}`),
      check(
        "workspaces_reason_code_check",
        sql`${table.reasonCode} IS NULL OR ${table.reasonCode} IN ${sqlValues(REASON_CODES)}`,
      ),
      check("workspaces_agent_state_check", sql`${table.agentState} IN ${sqlValues(AGENT_STATES)}`),
      check("workspaces_network_state_check", sql`${table.networkState} IN ${sqlValues(NETWORK_STATES)}`),
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
      index("workspaces_deadline").on(table.deadlineAt).where(sql`${table.state} NOT IN ${terminalStates}`),
    ],
  );

  const workspaceNetworkEvents = table(
    "workspace_network_events",
    {
      workspaceId: uuid("workspace_id")
        .notNull()
        .references(() => workspaces.id, { onDelete: "cascade" }),
      seq: bigint("seq", { mode: "number" }).notNull(),
      sourceSessionId: uuid("source_session_id").notNull(),
      sourceSeq: bigint("source_seq", { mode: "number" }).notNull(),
      occurredAt: timestamptz("occurred_at").notNull(),
      decision: text("decision", { enum: ["allow", "deny"] }).notNull(),
      transport: text("transport", { enum: ["http", "https"] }).notNull(),
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

  const workspaceTerminalSessions = table(
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
      closeReason: text("close_reason").$type<NonNullable<TerminalSessionRow["closeReason"]>>(),
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
      index("workspace_terminal_sessions_page").on(table.workspaceId, table.openedAt, table.sessionId),
    ],
  );

  const warmPoolRuntimes = table(
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
      state: text("state").$type<NonNullable<WarmPoolRuntimeRow["state"]>>().notNull(),
      providerRef: structuredJson("provider_ref").$type<NonNullable<WarmPoolRuntimeRow["providerRef"]>>(),
      enrollmentDigest: bytea("enrollment_digest").$type<Uint8Array>(),
      enrollmentExpiresAt: timestamptz("enrollment_expires_at"),
      workspaceId: uuid("workspace_id").references(() => workspaces.id),
      createdAt: timestamptz("created_at").notNull(),
      updatedAt: timestamptz("updated_at").notNull(),
      readyAt: timestamptz("ready_at"),
      leasedAt: timestamptz("leased_at"),
      failureCode: text("failure_code"),
    },
    (table) => [
      check("warm_pool_runtimes_state_check", sql`${table.state} IN ${sqlValues(WARM_POOL_RUNTIME_STATES)}`),
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

  return { workspaces, workspaceNetworkEvents, workspaceTerminalSessions, warmPoolRuntimes };
}
