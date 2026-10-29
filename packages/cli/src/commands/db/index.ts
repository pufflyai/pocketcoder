import { getMigrationStatus, type MigrationStatus, migrateDatabase, postgresSqlClient } from "@pstdio/pocketcoder-db";
import { databaseLocation } from "@pstdio/pocketcoder-server/store-config";
import { SQL } from "bun";
import type { Argv } from "yargs";
import { addAction, addResource, unchanged } from "../command";

async function withDatabase<T>(work: (client: ReturnType<typeof postgresSqlClient>, schema: string) => Promise<T>) {
  const { databaseUrl, databaseSchema } = databaseLocation(process.env);
  const sql = new SQL(databaseUrl, { max: 1 });
  try {
    return await work(postgresSqlClient(sql), databaseSchema);
  } finally {
    await sql.end();
  }
}

export function formatMigrationStatus(migrations: readonly Pick<MigrationStatus, "name" | "appliedAt">[]) {
  return migrations.map(
    (migration) =>
      `${migration.name}\t${migration.appliedAt ? `applied ${migration.appliedAt.toISOString()}` : "pending"}`,
  );
}

// PGlite migrates its own data folder on open. A shared PostgreSQL database is migrated
// once by an operator step, before controllers of the new release start.
export function addDatabaseCommands(parser: Argv) {
  return addResource(parser, "db", "Migrate and inspect the PostgreSQL store", (commands) => {
    addAction(commands, "migrate", "Apply pending migrations to POCKETCODER_DATABASE_URL", unchanged, async () => {
      const applied = await withDatabase((client, schema) => migrateDatabase(client, undefined, schema));
      console.log(applied.length ? `applied: ${applied.join(", ")}` : "database is up to date");
    });
    addAction(commands, "status", "Show applied and pending migrations", unchanged, async () => {
      const status = await withDatabase((client, schema) => getMigrationStatus(client, schema));
      for (const line of formatMigrationStatus(status)) console.log(line);
    });
    return commands;
  });
}
