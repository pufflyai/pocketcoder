import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { postgresSqlClient } from "./database/sql-client";
import { migrateDatabase } from "./migrations/migrator";

export const TEST_DATABASE_URL = process.env.POCKETCODER_TEST_DATABASE_URL;
// CI runs the shared store suites once per driver. PGlite stays the default for local runs.
export const TEST_STORE_DRIVER = process.env.POCKETCODER_TEST_STORE === "postgres" ? "postgres" : "pglite";

export function requireTestDatabaseUrl() {
  if (!TEST_DATABASE_URL) throw new Error("POCKETCODER_TEST_DATABASE_URL is required for PostgreSQL tests");
  return TEST_DATABASE_URL;
}

// Each fixture owns a fresh database, so test files run in parallel and raw SQL in tests
// can keep naming the default "pocketcoder" schema.
export async function createPostgresTestDatabase(prefix = "pc_test", options: { migrate?: boolean } = {}) {
  const server = requireTestDatabaseUrl();
  const name = `${prefix.replaceAll("-", "_").toLowerCase().slice(0, 40)}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const root = new SQL(server, { max: 1 });
  await root.unsafe(`CREATE DATABASE "${name}"`);
  const url = new URL(server);
  url.pathname = `/${name}`;
  const admin = new SQL(url.toString(), { max: 1 });
  const journalDir = await mkdtemp(join(tmpdir(), `${name}-journal-`));
  const schema = "pocketcoder";
  if (options.migrate !== false) await migrateDatabase(postgresSqlClient(admin), undefined, schema);
  return {
    url: url.toString(),
    schema,
    journalDir,
    admin,
    async drop() {
      try {
        await admin.end();
        await root.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await root.end();
        await rm(journalDir, { recursive: true, force: true });
      }
    },
  };
}
