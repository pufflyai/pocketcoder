import migrations from "../../assets/migrations.json" with { type: "json" };
import type { SqlClient } from "../database/sql-client";
import { advisoryLockKey, assertValidSchema } from "../database-schema";
import { FIRST_1_0_MIGRATION, normalizeLegacyJson } from "./legacy-json";
import { RELEASE_081_MIGRATION } from "./release-081";
import { planUpgrade } from "./upgrade";

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

async function appliedMigrations(client: SqlClient, schema = SCHEMA) {
  const rows = await client.query<{ relation: string | null }>("SELECT to_regclass($1)::text AS relation", [
    `${schema}.__drizzle_migrations`,
  ]);
  if (!rows[0]?.relation) return [];
  return client.query<AppliedMigration>(
    `SELECT name, hash, applied_at FROM "${schema}"."__drizzle_migrations" ORDER BY created_at, id`,
  );
}

export type MigrationRegistry = ReadonlyArray<{
  name: string;
  hash: string;
  folderMillis: number;
  sql: readonly string[];
}>;

function assertHistory(applied: AppliedMigration[], registry: MigrationRegistry) {
  for (const [index, row] of applied.entries()) {
    const expected = registry[index];
    if (!expected || row.name !== expected.name) throw new Error(`unknown or out-of-order migration: ${row.name}`);
    if (row.hash !== expected.hash) throw new Error(`migration ${row.name} has checksum drift`);
  }
}

export async function migrateDatabase(client: SqlClient, registry: MigrationRegistry = migrations, schema = SCHEMA) {
  assertValidSchema(schema);
  const table = `"${schema}"."__drizzle_migrations"`;
  return client.transaction(async (tx) => {
    // PostgreSQL can have other controllers or operator commands connected to the same schema.
    await tx.query("SELECT pg_advisory_xact_lock($1)", [advisoryLockKey(schema).toString()]);
    // Check the full history before any schema writes, including new migration tables.
    const plan = planUpgrade(await appliedMigrations(tx, schema), registry);
    assertHistory(plan.applied, plan.registry);
    const pending = plan.registry.slice(plan.applied.length);
    if (!pending.length) return [];
    const fromRelease0 = plan.applied.length > 0 && !plan.applied.some((row) => row.name === FIRST_1_0_MIGRATION);
    await tx.exec(`CREATE SCHEMA IF NOT EXISTS "${schema}";
      SET LOCAL search_path TO "${schema}";
      CREATE TABLE IF NOT EXISTS ${table} (
        id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint,
        name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
      );`);
    if (plan.release081) await tx.query(`DELETE FROM ${table} WHERE name = $1`, [RELEASE_081_MIGRATION.name]);
    for (const migration of pending) {
      for (const statement of migration.sql) await tx.exec(statement);
      await tx.query(`INSERT INTO ${table} (hash, created_at, name) VALUES ($1, $2, $3)`, [
        migration.hash,
        migration.folderMillis,
        migration.name,
      ]);
    }
    if (fromRelease0) await normalizeLegacyJson(tx, schema);
    return pending.map((migration) => migration.name);
  });
}

export async function getMigrationStatus(client: SqlClient, schema = SCHEMA): Promise<MigrationStatus[]> {
  const { applied } = planUpgrade(await appliedMigrations(client, schema), migrations);
  assertHistory(applied, migrations);
  return migrations.map((migration, index) => ({
    name: migration.name,
    checksum: migration.hash,
    appliedAt: applied[index] ? new Date(applied[index].applied_at) : null,
    drifted: false,
  }));
}
