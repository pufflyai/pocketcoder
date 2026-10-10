import type { PGlite, Transaction } from "@electric-sql/pglite";
import migrations from "../../assets/migrations.json" with { type: "json" };
import { assertValidSchema } from "../database-schema";

const SCHEMA = "pocketcoder";

export interface MigrationStatus {
  name: string;
  checksum: string;
  appliedAt: Date | null;
  drifted: boolean;
}

interface AppliedMigration {
  name: string;
  hash: string;
  applied_at: Date | string;
}

async function appliedMigrations(client: PGlite | Transaction, schema = SCHEMA) {
  const { rows } = await client.query<{ relation: string | null }>("SELECT to_regclass($1) AS relation", [
    `${schema}.__drizzle_migrations`,
  ]);
  if (!rows[0]?.relation) return [];
  return (
    await client.query<AppliedMigration>(
      `SELECT name, hash, applied_at FROM "${schema}"."__drizzle_migrations" ORDER BY created_at, id`,
    )
  ).rows;
}

type MigrationRegistry = ReadonlyArray<{ name: string; hash: string; folderMillis: number; sql: readonly string[] }>;

function assertHistory(applied: AppliedMigration[], registry: MigrationRegistry) {
  for (const [index, row] of applied.entries()) {
    const expected = registry[index];
    if (!expected || row.name !== expected.name) throw new Error(`unknown or out-of-order migration: ${row.name}`);
    if (row.hash !== expected.hash) throw new Error(`migration ${row.name} has checksum drift`);
  }
}

export async function migrateDatabase(client: PGlite, registry: MigrationRegistry = migrations, schema = SCHEMA) {
  // Check the full history before any schema writes, including new migration tables.
  assertValidSchema(schema);
  const table = `"${schema}"."__drizzle_migrations"`;
  const applied = await appliedMigrations(client, schema);
  assertHistory(applied, registry);
  const pending = registry.slice(applied.length);
  if (!pending.length) return [];
  await client.transaction(async (tx) => {
    await tx.exec(`CREATE SCHEMA IF NOT EXISTS "${schema}";
      SET LOCAL search_path TO "${schema}";
      CREATE TABLE IF NOT EXISTS ${table} (
        id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint,
        name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
      );`);
    for (const migration of pending) {
      for (const statement of migration.sql) await tx.exec(statement);
      await tx.query(`INSERT INTO ${table} (hash, created_at, name) VALUES ($1, $2, $3)`, [
        migration.hash,
        migration.folderMillis,
        migration.name,
      ]);
    }
  });
  return pending.map((migration) => migration.name);
}

export async function getMigrationStatus(client: PGlite): Promise<MigrationStatus[]> {
  const applied = await appliedMigrations(client);
  assertHistory(applied, migrations);
  return migrations.map((migration, index) => ({
    name: migration.name,
    checksum: migration.hash,
    appliedAt: applied[index] ? new Date(applied[index].applied_at) : null,
    drifted: false,
  }));
}
