import { TEMPLATE_STATUSES } from "@pstdio/pocketcoder-runtime-contracts";
import { sql } from "drizzle-orm";
import { bytea, check, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { sqlValues, timestamptz } from "./columns";

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
  (table) => [
    unique().on(table.name, table.version),
    check("templates_status_check", sql`${table.status} IN ${sqlValues(TEMPLATE_STATUSES)}`),
  ],
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
