import { REASON_CODES, WORKSPACE_STATES } from "@pstdio/pocketcoder-contracts";
import type {
  ConversationMessageRow,
  ConversationStateRow,
  LogRow,
  StateHistoryRow,
} from "@pstdio/pocketcoder-runtime-contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  bytea,
  check,
  index,
  integer,
  jsonb,
  type PgTableFn,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sqlValues, timestamptz } from "./columns";
import type { createWorkspaceTables } from "./workspaces";

export function createActivityTables(
  table: PgTableFn<string | undefined> = pgTable,
  { workspaces }: ReturnType<typeof createWorkspaceTables>,
) {
  const workspaceOutputs = table(
    "workspace_outputs",
    {
      workspaceId: uuid("workspace_id")
        .notNull()
        .references(() => workspaces.id),
      seq: bigint("seq", { mode: "number" }).notNull(),
      name: text("name").notNull(),
      value: jsonb("value").$type<unknown>().notNull(),
      occurredAt: timestamptz("occurred_at").notNull(),
    },
    (table) => [primaryKey({ columns: [table.workspaceId, table.seq] })],
  );

  const workspaceConversations = table("workspace_conversations", {
    workspaceId: uuid("workspace_id")
      .primaryKey()
      .references(() => workspaces.id),
    status: text("status").$type<NonNullable<ConversationStateRow["status"]>>().notNull(),
    expiresAt: timestamptz("expires_at"),
    deletedAt: timestamptz("deleted_at"),
    updatedAt: timestamptz("updated_at").notNull(),
  });

  const workspaceConversationMessages = table(
    "workspace_conversation_messages",
    {
      workspaceId: uuid("workspace_id")
        .notNull()
        .references(() => workspaces.id),
      seq: bigint("seq", { mode: "number" }).notNull(),
      messageId: text("message_id").notNull(),
      role: text("role").$type<NonNullable<ConversationMessageRow["role"]>>().notNull(),
      content: text("content").notNull(),
      occurredAt: timestamptz("occurred_at").notNull(),
      metadata: jsonb("metadata").$type<NonNullable<ConversationMessageRow["metadata"]>>().notNull().default({}),
      createdAt: timestamptz("created_at").notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.workspaceId, table.seq] }),
      unique().on(table.workspaceId, table.messageId),
    ],
  );

  const workspaceStateHistory = table(
    "workspace_state_history",
    {
      id: uuid("id").primaryKey(),
      workspaceId: uuid("workspace_id")
        .notNull()
        .references(() => workspaces.id),
      fromState: text("from_state").$type<NonNullable<StateHistoryRow["fromState"]>>(),
      toState: text("to_state").$type<NonNullable<StateHistoryRow["toState"]>>().notNull(),
      reasonCode: text("reason_code").$type<NonNullable<StateHistoryRow["reasonCode"]>>(),
      occurredAt: timestamptz("occurred_at").notNull(),
    },
    (table) => [
      check(
        "workspace_state_history_from_check",
        sql`${table.fromState} IS NULL OR ${table.fromState} IN ${sqlValues(WORKSPACE_STATES)}`,
      ),
      check("workspace_state_history_to_check", sql`${table.toState} IN ${sqlValues(WORKSPACE_STATES)}`),
      check(
        "workspace_state_history_reason_check",
        sql`${table.reasonCode} IS NULL OR ${table.reasonCode} IN ${sqlValues(REASON_CODES)}`,
      ),
      index("workspace_state_history_ws").on(table.workspaceId, table.occurredAt),
    ],
  );

  const workspaceLogs = table(
    "workspace_logs",
    {
      workspaceId: uuid("workspace_id")
        .notNull()
        .references(() => workspaces.id),
      seq: bigint("seq", { mode: "number" }).notNull(),
      stream: text("stream").$type<NonNullable<LogRow["stream"]>>().notNull(),
      occurredAt: timestamptz("occurred_at").notNull(),
      content: bytea("content").$type<Uint8Array>().notNull(),
    },
    (table) => [primaryKey({ columns: [table.workspaceId, table.seq] })],
  );

  const eventOutbox = table(
    "event_outbox",
    {
      id: uuid("id").primaryKey(),
      workspaceId: uuid("workspace_id")
        .notNull()
        .references(() => workspaces.id),
      eventType: text("event_type").notNull(),
      payload: jsonb("payload").$type<unknown>().notNull(),
      occurredAt: timestamptz("occurred_at").notNull(),
      nextAttemptAt: timestamptz("next_attempt_at").notNull(),
      attemptCount: integer("attempt_count").notNull().default(0),
      deliveredAt: timestamptz("delivered_at"),
      lastErrorCode: text("last_error_code"),
    },
    (table) => [index("event_outbox_due").on(table.nextAttemptAt).where(sql`${table.deliveredAt} IS NULL`)],
  );

  return {
    workspaceOutputs,
    workspaceConversations,
    workspaceConversationMessages,
    workspaceStateHistory,
    workspaceLogs,
    eventOutbox,
  };
}
