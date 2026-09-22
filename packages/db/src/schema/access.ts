import type { TemplateRow } from "@pstdio/pocketcoder-runtime-contracts";
import { TEMPLATE_STATUSES } from "@pstdio/pocketcoder-runtime-contracts";
import { sql } from "drizzle-orm";
import { bytea, check, type PgTableFn, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { sqlValues, timestamptz } from "./columns";
import { structuredJson } from "./structured-json";

export function createAccessTables(table: PgTableFn<string | undefined> = pgTable) {
  const templates = table(
    "templates",
    {
      id: uuid("id").primaryKey(),
      name: text("name").notNull(),
      version: text("version").notNull(),
      digest: text("digest").notNull().unique(),
      description: text("description"),
      spec: structuredJson("spec").$type<NonNullable<TemplateRow["spec"]>>().notNull(),
      status: text("status").$type<NonNullable<TemplateRow["status"]>>().notNull(),
      createdAt: timestamptz("created_at").notNull(),
      retiredAt: timestamptz("retired_at"),
    },
    (table) => [
      unique().on(table.name, table.version),
      check("templates_status_check", sql`${table.status} IN ${sqlValues(TEMPLATE_STATUSES)}`),
    ],
  );

  const principals = table("principals", {
    id: uuid("id").primaryKey(),
    name: text("name").notNull().unique(),
    scopes: text("scopes").array().notNull(),
    templateNames: text("template_names").array().notNull(),
    disabledAt: timestamptz("disabled_at"),
    createdAt: timestamptz("created_at").notNull(),
  });

  const machineKeys = table(
    "machine_keys",
    {
      issuanceRequestId: text("issuance_request_id"),
      issuanceRequestDigest: text("issuance_request_digest"),
      managedPrincipalIds: text("managed_principal_ids").array().notNull().default([]),
      id: uuid("id").primaryKey(),
      principalId: uuid("principal_id")
        .notNull()
        .references(() => principals.id),
      secretDigest: bytea("secret_digest").$type<Uint8Array>().notNull(),
      scopes: text("scopes").array().notNull(),
      createdAt: timestamptz("created_at").notNull(),
      expiresAt: timestamptz("expires_at"),
      revokedAt: timestamptz("revoked_at"),
      lastUsedAt: timestamptz("last_used_at"),
    },
    (table) => [unique().on(table.principalId, table.issuanceRequestId)],
  );

  return { templates, principals, machineKeys };
}
