import type { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate as runDrizzleMigrations } from "drizzle-orm/pg-core";
import { MIGRATIONS } from "./migrations";
import { advisoryLockKey, assertValidSchema } from "./schema";

// Drizzle migrations run on one reserved connection under a schema-scoped
// advisory lock. search_path lets the generated, unqualified DDL target the
// configurable PocketCoder schema; all application queries remain qualified.

const MIGRATIONS_TABLE = "__drizzle_migrations";

export interface MigrationStatus {
	version: string;
	checksum: string;
	appliedAt: Date | null;
	drifted: boolean;
}

interface AppliedMigration {
	hash: string;
	name: string | null;
	applied_at: Date | string | null;
}

type MigrationConnection = Awaited<ReturnType<SQL["reserve"]>>;

function table(schema: string, name: string): string {
	return `"${schema}"."${name}"`;
}

async function migrationTableExists(
	connection: MigrationConnection | SQL,
	schema: string,
	name: string,
): Promise<boolean> {
	const rows = (await connection.unsafe("SELECT to_regclass($1) AS relation", [
		`${schema}.${name}`,
	])) as Array<{ relation: string | null }>;
	return rows[0]?.relation != null;
}

async function appliedMigrations(
	connection: MigrationConnection | SQL,
	schema: string,
): Promise<AppliedMigration[]> {
	if (!(await migrationTableExists(connection, schema, MIGRATIONS_TABLE))) return [];
	return (await connection.unsafe(
		`SELECT hash, name, applied_at FROM ${table(schema, MIGRATIONS_TABLE)}`,
	)) as AppliedMigration[];
}

function assertNoDrift(applied: AppliedMigration[]): void {
	const byName = new Map(applied.map((migration) => [migration.name, migration]));
	for (const migration of MIGRATIONS) {
		const existing = byName.get(migration.name);
		if (existing && existing.hash !== migration.hash) {
			throw new Error(`migration ${migration.name} changed after being applied (checksum drift)`);
		}
	}
}

export async function migrate(sql: SQL, schema: string): Promise<string[]> {
	assertValidSchema(schema);
	const connection = await sql.reserve();
	const lockKey = advisoryLockKey(schema);
	let locked = false;
	try {
		await connection.unsafe("SELECT pg_advisory_lock($1)", [lockKey]);
		locked = true;
		await connection.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
		await connection.unsafe(`SET search_path TO "${schema}"`);

		const before = await appliedMigrations(connection, schema);
		assertNoDrift(before);

		const db = drizzle({ client: connection });
		await runDrizzleMigrations(MIGRATIONS, db, {
			migrationsFolder: "embedded",
			migrationsSchema: schema,
			migrationsTable: MIGRATIONS_TABLE,
		});

		const previouslyApplied = new Set(before.map((migration) => migration.name));
		return MIGRATIONS.filter((migration) => !previouslyApplied.has(migration.name)).map(
			(migration) => migration.name,
		);
	} finally {
		try {
			await connection.unsafe("RESET search_path");
		} finally {
			try {
				if (locked) await connection.unsafe("SELECT pg_advisory_unlock($1)", [lockKey]);
			} finally {
				connection.release();
			}
		}
	}
}

export async function migrationStatus(sql: SQL, schema: string): Promise<MigrationStatus[]> {
	assertValidSchema(schema);
	const rows = await appliedMigrations(sql, schema);
	const byName = new Map(rows.map((migration) => [migration.name, migration]));
	return MIGRATIONS.map((migration) => {
		const applied = byName.get(migration.name);
		return {
			version: migration.name,
			checksum: migration.hash,
			appliedAt: applied?.applied_at == null ? null : new Date(applied.applied_at),
			drifted: applied !== undefined && applied.hash !== migration.hash,
		};
	});
}
