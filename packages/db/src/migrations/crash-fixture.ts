import { PGlite } from "@electric-sql/pglite";
import { loadCoreAssets } from "../database/assets";
import { DurableFilesystem } from "../database/durable-filesystem";
import { migrateDatabase } from "./migrator";

export const initialMigration = {
  name: "initial",
  hash: "initial",
  folderMillis: 1,
  sql: ['CREATE TABLE "before_upgrade" (id integer PRIMARY KEY);'],
};

export function upgradeMigration(interrupt = false) {
  const sql = ['CREATE TABLE "after_upgrade" (id integer PRIMARY KEY);'];
  if (interrupt) sql.push("COPY (SELECT 'started') TO '/pglite/data/upgrade-started';", "SELECT pg_sleep(60);");
  return { name: "upgrade", hash: "upgrade", folderMillis: 2, sql };
}

export async function openMigrationDatabase(dir: string) {
  const assets = await loadCoreAssets();
  return PGlite.create({
    fs: new DurableFilesystem(dir),
    pgliteWasmModule: assets.pgliteWasmModule,
    fsBundle: assets.fsBundle,
    relaxedDurability: false,
    postgresqlconf: ["shared_buffers = 16MB"],
    startParams: PGlite.defaultStartParams.filter((param) => param !== "-F"),
  });
}

if (import.meta.main) {
  const [dir] = process.argv.slice(2);
  if (!dir) throw new Error("database path required");
  const client = await openMigrationDatabase(dir);
  await migrateDatabase(client, [initialMigration, upgradeMigration(true)]);
  await client.close();
}
