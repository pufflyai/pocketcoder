import { SECRET_TYPES, type SecretType } from "@pstdio/pocketcoder-contracts";
import { sql } from "drizzle-orm";
import { bytea, check, foreignKey, type PgTableFn, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { sqlValues, timestamptz } from "./columns";

export function createSecretTables(table: PgTableFn<string | undefined> = pgTable) {
  // Old issuer configurations remain available to revoke already issued leases.
  const secretVersions = table(
    "secret_versions",
    {
      id: uuid("id").primaryKey(),
      name: text("name").notNull(),
      type: text("type").$type<SecretType>().notNull(),
      nonce: bytea("nonce").$type<Uint8Array>().notNull().unique(),
      ciphertext: bytea("ciphertext").$type<Uint8Array>().notNull(),
      tag: bytea("tag").$type<Uint8Array>().notNull(),
      createdAt: timestamptz("created_at").notNull(),
    },
    (row) => [
      unique().on(row.id, row.name, row.type),
      check("secret_versions_type_check", sql`${row.type} IN ${sqlValues(SECRET_TYPES)}`),
      check("secret_versions_nonce_length", sql`octet_length(${row.nonce}) = 12`),
      check("secret_versions_tag_length", sql`octet_length(${row.tag}) = 16`),
    ],
  );
  const secrets = table(
    "secrets",
    {
      name: text("name").primaryKey(),
      type: text("type").$type<SecretType>().notNull(),
      versionId: uuid("version_id").notNull(),
      updatedAt: timestamptz("updated_at").notNull(),
      retiredAt: timestamptz("retired_at"),
    },
    (row) => [
      foreignKey({
        columns: [row.versionId, row.name, row.type],
        foreignColumns: [secretVersions.id, secretVersions.name, secretVersions.type],
      }),
    ],
  );
  return { secrets, secretVersions };
}
