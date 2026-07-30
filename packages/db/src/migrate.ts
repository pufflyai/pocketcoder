import { createHash } from "node:crypto";
import type { SQL } from "bun";
import { MIGRATIONS } from "./migrations";
import { advisoryLockKey, assertValidSchema } from "./schema";

// Runs every pending migration inside one session holding the schema-scoped
// advisory lock. The same command works against a dedicated database or an
// existing one; only the configured schema is touched.

export interface MigrationStatus {
	version: string;
	checksum: string;
	appliedAt: Date | null;
	drifted: boolean;
}

function checksumOf(up: string): string {
	return createHash("sha256").update(up).digest("hex");
}

export async function migrate(sql: SQL, schema: string): Promise<string[]> {
	assertValidSchema(schema);
	const applied: string[] = [];
	await sql.begin(async (tx) => {
		await tx.unsafe("SELECT pg_advisory_xact_lock($1)", [advisoryLockKey(schema)]);
		await tx.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
		await tx.unsafe(`CREATE TABLE IF NOT EXISTS "${schema}".schema_migrations (
			version text PRIMARY KEY,
			checksum text NOT NULL,
			applied_at timestamptz NOT NULL DEFAULT now()
		)`);
		const rows = (await tx.unsafe(
			`SELECT version, checksum FROM "${schema}".schema_migrations`,
		)) as Array<{ version: string; checksum: string }>;
		const appliedByVersion = new Map(rows.map((r) => [r.version, r.checksum]));
		for (const migration of MIGRATIONS) {
			const checksum = checksumOf(migration.up);
			const existing = appliedByVersion.get(migration.version);
			if (existing !== undefined) {
				if (existing !== checksum) {
					throw new Error(
						`migration ${migration.version} changed after being applied (checksum drift)`,
					);
				}
				continue;
			}
			await tx.unsafe(migration.up.replaceAll("{{schema}}", `"${schema}"`));
			await tx.unsafe(
				`INSERT INTO "${schema}".schema_migrations (version, checksum) VALUES ($1, $2)`,
				[migration.version, checksum],
			);
			applied.push(migration.version);
		}
	});
	return applied;
}

export async function migrationStatus(sql: SQL, schema: string): Promise<MigrationStatus[]> {
	assertValidSchema(schema);
	let rows: Array<{ version: string; checksum: string; applied_at: Date }> = [];
	try {
		rows = (await sql.unsafe(
			`SELECT version, checksum, applied_at FROM "${schema}".schema_migrations`,
		)) as typeof rows;
	} catch {
		// Schema or table does not exist yet; everything is pending.
	}
	const appliedByVersion = new Map(rows.map((r) => [r.version, r]));
	return MIGRATIONS.map((m) => {
		const applied = appliedByVersion.get(m.version);
		return {
			version: m.version,
			checksum: checksumOf(m.up),
			appliedAt: applied?.applied_at ?? null,
			drifted: applied !== undefined && applied.checksum !== checksumOf(m.up),
		};
	});
}
