import { REASON_CODES, WORKSPACE_STATES } from "@pstdio/pocketcoder-contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  bytea,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sqlValues, timestamptz } from "./columns";
import { workspaces } from "./workspaces";

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
  (table) => [
    check(
      "workspace_state_history_from_check",
      sql`${table.fromState} IS NULL OR ${table.fromState} IN ${sqlValues(WORKSPACE_STATES)}`,
    ),
    check(
      "workspace_state_history_to_check",
      sql`${table.toState} IN ${sqlValues(WORKSPACE_STATES)}`,
    ),
    check(
      "workspace_state_history_reason_check",
      sql`${table.reasonCode} IS NULL OR ${table.reasonCode} IN ${sqlValues(REASON_CODES)}`,
    ),
    index("workspace_state_history_ws").on(table.workspaceId, table.occurredAt),
  ],
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
