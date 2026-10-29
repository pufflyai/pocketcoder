import type { ConversationRecordDocument } from "@pstdio/pocketcoder-contracts";
import type { ConversationDocumentRow } from "@pstdio/pocketcoder-runtime-contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  type PgTableFn,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { createAccessTables } from "./access";
import { timestamptz } from "./columns";
import type { createWorkspaceTables } from "./workspaces";

// One document per conversation, assembled from immutable JSON records written at turn
// boundaries. Totals are running values, so a write never scans earlier history.
export function createConversationTables(
  table: PgTableFn<string | undefined> = pgTable,
  { workspaces }: ReturnType<typeof createWorkspaceTables>,
  { principals }: ReturnType<typeof createAccessTables>,
) {
  const conversations = table(
    "conversations",
    {
      id: uuid("id").primaryKey(),
      principalId: uuid("principal_id")
        .notNull()
        .references(() => principals.id),
      // The caller's identity. Null for the messages of one workspace that carry no identity.
      conversationId: uuid("conversation_id"),
      // The workspace that wrote last; retention starts when it ends.
      workspaceId: uuid("workspace_id")
        .notNull()
        .references(() => workspaces.id),
      legacy: boolean("legacy").notNull().default(false),
      status: text("status").$type<ConversationDocumentRow["status"]>().notNull(),
      recordCount: integer("record_count").notNull().default(0),
      messageCount: integer("message_count").notNull().default(0),
      bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
      lastSeq: bigint("last_seq", { mode: "number" }).notNull().default(0),
      expiresAt: timestamptz("expires_at"),
      // Set once retention has been applied after the last workspace ended. A new turn clears it.
      retentionSet: boolean("retention_set").notNull().default(false),
      deletedAt: timestamptz("deleted_at"),
      createdAt: timestamptz("created_at").notNull(),
      updatedAt: timestamptz("updated_at").notNull(),
    },
    (table) => [
      unique("conversations_identity").on(table.principalId, table.conversationId),
      uniqueIndex("conversations_workspace_unidentified")
        .on(table.workspaceId)
        .where(sql`${table.conversationId} IS NULL`),
      index("conversations_workspace").on(table.workspaceId),
    ],
  );

  const conversationRecords = table(
    "conversation_records",
    {
      id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
      conversationRef: uuid("conversation_ref")
        .notNull()
        .references(() => conversations.id, { onDelete: "cascade" }),
      recordSeq: integer("record_seq").notNull(),
      // The turn ID, or the message ID of a message without identity. Repeated writes are no-ops.
      recordKey: text("record_key").notNull(),
      workspaceId: uuid("workspace_id")
        .notNull()
        .references(() => workspaces.id),
      firstSeq: bigint("first_seq", { mode: "number" }).notNull(),
      lastSeq: bigint("last_seq", { mode: "number" }).notNull(),
      status: text("status").$type<ConversationRecordDocument["status"]>().notNull(),
      document: jsonb("document").$type<ConversationRecordDocument>().notNull(),
      bytes: integer("bytes").notNull(),
      createdAt: timestamptz("created_at").notNull(),
    },
    (table) => [
      unique("conversation_records_seq").on(table.conversationRef, table.recordSeq),
      unique("conversation_records_key").on(table.conversationRef, table.recordKey),
      index("conversation_records_messages").on(table.conversationRef, table.lastSeq),
      index("conversation_records_workspace").on(table.workspaceId, table.id),
    ],
  );

  return { conversations, conversationRecords };
}
