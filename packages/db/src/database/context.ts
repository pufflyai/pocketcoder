import { existsSync } from "node:fs";
import { lstat, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrateDatabase } from "../migrations/migrator";
import { createSchema } from "../schema";
import { loadCoreAssets } from "./assets";
import { lockDataFolder, syncDirectory, syncSeed } from "./data-folder";
import { DurableFilesystem } from "./durable-filesystem";

export async function createDatabaseContext(dataDir?: string) {
  if (dataDir === "") throw new Error("data folder must not be empty");
  const folder = dataDir !== undefined ? lockDataFolder(dataDir) : undefined;
  let client: PGlite | undefined;
  try {
    const assets = await loadCoreAssets();
    const options = {
      pgliteWasmModule: assets.pgliteWasmModule,
      fsBundle: assets.fsBundle,
      relaxedDurability: false,
      postgresqlconf: ["shared_buffers = 16MB"],
      startParams: PGlite.defaultStartParams.filter((param) => param !== "-F"),
    };
    if (folder) {
      const databaseDir = join(folder.dir, "db");
      if (!existsSync(databaseDir)) {
        const stage = join(folder.dir, ".db-staging");
        await rm(stage, { recursive: true, force: true });
        // Install the seed before opening the engine to avoid two WASM memory peaks.
        await new Bun.Archive(await assets.loadDataDir.arrayBuffer()).extract(stage);
        if ((await readFile(join(stage, "PG_VERSION"), "utf8")).trim() !== "18")
          throw new Error("incompatible core seed engine format");
        syncSeed(stage);
        await rename(stage, databaseDir);
        syncDirectory(folder.dir);
      } else {
        if (!(await lstat(databaseDir)).isDirectory() || !(await readdir(databaseDir)).includes("PG_VERSION"))
          throw new Error("incomplete database directory; refusing to replace existing data");
        if ((await readFile(join(databaseDir, "PG_VERSION"), "utf8")).trim() !== "18")
          throw new Error("incompatible database engine format");
      }
      client = await PGlite.create({ ...options, fs: new DurableFilesystem(databaseDir) });
    } else {
      client = await PGlite.create({ ...options, loadDataDir: assets.memorySeed() });
    }
    await migrateDatabase(client);
    let closed = false;
    const database = client;
    return {
      schema: "pocketcoder",
      client: database,
      db: drizzle({ client: database }),
      tables: createSchema("pocketcoder"),
      changes: new Map<string, Set<() => void>>(),
      async close() {
        if (closed) return;
        closed = true;
        try {
          await database.close();
        } finally {
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
export type DatabaseContext = Awaited<ReturnType<typeof createDatabaseContext>>;
export type Transaction = Parameters<Parameters<DatabaseContext["db"]["transaction"]>[0]>[0];
export type QueryContext = DatabaseContext["db"] | Transaction;

// Row-spanning limits remain atomic inside the serialized database transaction.
export async function lock(tx: Transaction, name: string, seed: number) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${name}, ${seed}))`);
}

export function notifyChange(context: DatabaseContext, id: string) {
  const waiters = context.changes.get(id);
  context.changes.delete(id);
  for (const resolve of waiters ?? []) resolve();
}

export function createLifecycle(context: DatabaseContext) {
  let coordinator = false;
  return {
    async init() {},
    async acquireCoordinatorLease() {
      if (coordinator) throw new Error("a PocketCoder coordinator is already active");
      coordinator = true;
      return async () => {
        coordinator = false;
      };
    },
    async close() {
      for (const id of context.changes.keys()) notifyChange(context, id);
      await context.close();
    },
  };
}
