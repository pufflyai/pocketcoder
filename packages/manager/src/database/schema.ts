import { sql } from "drizzle-orm";
import { check, jsonb, type PgTableFn, pgSchema, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import type { ManagerConfig } from "../config";

export function managerSchema(schema?: string) {
  const table: PgTableFn<string | undefined> = schema ? pgSchema(schema).table : pgTable;
  const accounts = table(
    "accounts",
    {
      id: uuid().primaryKey(),
      name: text().notNull(),
      namespace: text().notNull().unique(),
      requestId: text("request_id").notNull().unique(),
      requestDigest: text("request_digest").notNull(),
      plan: jsonb().$type<ManagerConfig>().notNull(),
      state: text().$type<"provisioning" | "ready">().notNull(),
      bootstrapRequestId: uuid("bootstrap_request_id"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    },
    (t) => [check("account_state", sql`${t.state} in ('provisioning','ready')`)],
  );
  const operations = table(
    "operations",
    {
      id: uuid().primaryKey(),
      accountId: uuid("account_id")
        .notNull()
        .unique()
        .references(() => accounts.id),
      state: text().$type<"pending" | "running" | "succeeded">().notNull(),
      errorCode: text("error_code"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
      completedAt: timestamp("completed_at", { withTimezone: true }),
    },
    (t) => [check("operation_state", sql`${t.state} in ('pending','running','succeeded')`)],
  );
  const operators = table(
    "operators",
    {
      id: uuid().primaryKey(),
      digest: text().notNull().unique(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
      expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    },
    (t) => [
      check(
        "operator_expiry",
        sql`isfinite(${t.expiresAt}) and ${t.expiresAt} > ${t.createdAt} and ${t.expiresAt} <= ${t.createdAt} + interval '24 hours'`,
      ),
    ],
  );
  const bootstrapRequests = table(
    "bootstrap_requests",
    {
      id: uuid().primaryKey(),
      accountId: uuid("account_id")
        .notNull()
        .references(() => accounts.id),
      requestId: uuid("request_id").notNull(),
      requestDigest: text("request_digest").notNull(),
      expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
      replacesRequestId: uuid("replaces_request_id"),
      state: text().$type<"pending" | "completed">().notNull(),
      keyId: uuid("key_id"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    },
    (t) => [
      unique("bootstrap_identity").on(t.accountId, t.requestId),
      check("bootstrap_state", sql`${t.state} in ('pending','completed')`),
      check(
        "bootstrap_expiry",
        sql`isfinite(${t.expiresAt}) and ${t.expiresAt} > ${t.createdAt} and ${t.expiresAt} <= ${t.createdAt} + interval '24 hours'`,
      ),
    ],
  );
  return { accounts, operations, operators, bootstrapRequests };
}
export const { accounts, operations, operators, bootstrapRequests } = managerSchema();
