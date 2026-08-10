import {
  CHECKPOINT_STATES,
  CONVERSATION_RESTORE_CAPABILITIES,
  OPERATION_KINDS,
  OPERATION_STATES,
  STORAGE_STATES,
} from "@pstdio/pocketcoder-contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { principals } from "./access";
import { sqlValues, timestamptz } from "./columns";
import { workspaces } from "./workspaces";

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
    check("workspace_storage_state_check", sql`${table.state} IN ${sqlValues(STORAGE_STATES)}`),
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
    check(
      "workspace_checkpoints_state_check",
      sql`${table.state} IN ${sqlValues(CHECKPOINT_STATES)}`,
    ),
    check(
      "workspace_checkpoints_conversation_restore_check",
      sql`${table.conversationRestore} IN ${sqlValues(CONVERSATION_RESTORE_CAPABILITIES)}`,
    ),
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
    check("workspace_operations_kind_check", sql`${table.kind} IN ${sqlValues(OPERATION_KINDS)}`),
    check(
      "workspace_operations_state_check",
      sql`${table.state} IN ${sqlValues(OPERATION_STATES)}`,
    ),
    unique().on(table.principalId, table.kind, table.idempotencyKey),
    index("workspace_operations_due").on(table.state, table.updatedAt),
  ],
);
