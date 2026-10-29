import { existsSync } from "node:fs";
import { lstat, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { boundedFilesystem } from "../backup/bounded-filesystem";
import { bindJournal } from "../journal/binding";
import { migrateDatabase } from "../migrations/migrator";
import { createSchema } from "../schema";
import { loadCoreAssets } from "./assets";
import { bindCheckpointWriter } from "./checkpoint-writer";
import type { DatabaseOpenOptions, PGliteContext } from "./context";
import { lockDataFolder, syncDirectory, syncSeed } from "./data-folder";
import { DurableFilesystem } from "./durable-filesystem";
import { pgliteSqlClient } from "./sql-client";

// Returns the database folder, installing the seed on first start.
async function installDatabase(directory: string, assets: Awaited<ReturnType<typeof loadCoreAssets>>) {
  const databaseDir = join(directory, "db");
  if (!existsSync(databaseDir)) {
    const stage = join(directory, ".db-staging");
    await rm(stage, { recursive: true, force: true });
    // Install the seed before opening the engine to avoid two WASM memory peaks.
    await new Bun.Archive(assets.seedArchive()).extract(stage);
    if ((await readFile(join(stage, "PG_VERSION"), "utf8")).trim() !== "18")
      throw new Error("incompatible core seed engine format");
    await syncSeed(stage);
    await rename(stage, databaseDir);
    syncDirectory(directory);
    return databaseDir;
  }
  if (!(await lstat(databaseDir)).isDirectory() || !(await readdir(databaseDir)).includes("PG_VERSION"))
    throw new Error("incomplete database directory; refusing to replace existing data");
  if ((await readFile(join(databaseDir, "PG_VERSION"), "utf8")).trim() !== "18")
    throw new Error("incompatible database engine format");
  return databaseDir;
}

export async function createPGliteContext(dataDir?: string, hooks: DatabaseOpenOptions = {}): Promise<PGliteContext> {
  if (dataDir === "") throw new Error("data folder must not be empty");
  const folder = dataDir !== undefined ? lockDataFolder(dataDir) : undefined;
  let client: PGlite | undefined;
  try {
    if (folder && existsSync(join(folder.dir, "FORMAT"))) throw new Error("incompatible core data format");
    if (folder) await hooks.beforeOpen?.(folder.dir);
    const assets = await loadCoreAssets();
    const options = {
      pgliteWasmModule: assets.pgliteWasmModule,
      fsBundle: assets.fsBundle,
      relaxedDurability: false,
      postgresqlconf: ["shared_buffers = 16MB"],
      startParams: PGlite.defaultStartParams.filter((param) => param !== "-F"),
    };
    const databaseDir = folder ? await installDatabase(folder.dir, assets) : undefined;
    client = databaseDir
      ? await PGlite.create({
          ...options,
          fs: boundedFilesystem(new DurableFilesystem(databaseDir), databaseDir, hooks.databaseBudget),
        })
      : await PGlite.create({ ...options, loadDataDir: assets.memorySeed() });
    await migrateDatabase(pgliteSqlClient(client));
    const tables = createSchema("pocketcoder");
    const db = drizzle({ client });
    const dataWriter = await bindCheckpointWriter(db, tables, folder);
    const journal =
      folder && dataWriter ? await bindJournal(db, tables, folder.dir, dataWriter, hooks.journalDir) : undefined;
    let closed = false;
    const database = client;
    return {
      driver: "pglite",
      schema: "pocketcoder",
      client: database,
      sql: pgliteSqlClient(database),
      db,
      tables,
      dataWriter,
      journal,
      acknowledgeJournal: hooks.acknowledgeJournal,
      dataDir: folder?.dir,
      validateStorage: folder?.validate,
      changes: new Map<string, Set<() => void>>(),
      async close() {
        if (closed) return;
        closed = true;
        try {
          await database.close();
        } finally {
          journal?.close();
          folder?.close();
        }
      },
    };
  } catch (error) {
    try {
      await client?.close();
    } finally {
      folder?.close();
    }
    throw error;
  }
}
