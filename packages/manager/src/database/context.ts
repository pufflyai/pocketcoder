/// <reference path="./file-types.d.ts" />
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { lstat, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { PGlite } from "@electric-sql/pglite";
import {
  DurableFilesystem,
  loadDatabaseEngine,
  lockDataFolder,
  migrateDatabase,
  syncDirectory,
  syncSeed,
} from "@pstdio/pocketcoder-db/engine";
import { drizzle } from "drizzle-orm/pglite";
import manifest from "../../assets/manager-seed.json" with { type: "json" };
import seedPath from "../../assets/manager-seed.tar.br" with { type: "file" };
import migrations from "../../assets/migrations.json" with { type: "json" };
import { dependencies } from "../../package.json" with { type: "json" };
import { managerSchema } from "./schema";

let seed: Promise<Blob> | undefined;
function loadSeed() {
  seed ??= (async () => {
    if (
      manifest.app !== "pocketcoder-manager" ||
      manifest.pgliteVersion !== dependencies["@electric-sql/pglite"] ||
      JSON.stringify(manifest.migrations) !== JSON.stringify(migrations.map(({ name, hash }) => ({ name, hash })))
    )
      throw new Error("incompatible manager seed");
    for (const migration of migrations)
      if (createHash("sha256").update(migration.sql.join("--> statement-breakpoint")).digest("hex") !== migration.hash)
        throw new Error("manager migration checksum drift");
    const bytes = await Bun.file(new URL(seedPath, import.meta.url)).bytes();
    if (createHash("sha256").update(bytes).digest("hex") !== manifest.checksum)
      throw new Error("manager seed checksum drift");
    return new Blob([brotliDecompressSync(bytes)]);
  })();
  return seed;
}
function bindFormat(directory: string) {
  const path = join(directory, "FORMAT");
  if (!existsSync(path)) {
    if (existsSync(join(directory, "db"))) throw new Error("existing folder is not manager data");
    const file = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(file, "pocketcoder-manager/v1\n");
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    syncDirectory(directory);
  }
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (readFileSync(file, "utf8") !== "pocketcoder-manager/v1\n") throw new Error("incompatible manager data format");
  } finally {
    closeSync(file);
  }
}
export async function managerContext(dataDir?: string) {
  if (dataDir === "") throw new Error("data folder must not be empty");
  const folder = dataDir !== undefined ? lockDataFolder(dataDir) : undefined;
  let client: PGlite | undefined;
  try {
    if (folder) await bindFormat(folder.dir);
    const archive = await loadSeed();
    const engine = await loadDatabaseEngine();
    const options = {
      ...engine,
      relaxedDurability: false,
      postgresqlconf: ["shared_buffers = 16MB"],
      startParams: PGlite.defaultStartParams.filter((p) => p !== "-F"),
    };
    if (folder) {
      const database = join(folder.dir, "db");
      if (!existsSync(database)) {
        const stage = join(folder.dir, ".db-staging");
        await rm(stage, { recursive: true, force: true });
        await new Bun.Archive(await archive.arrayBuffer()).extract(stage);
        await syncSeed(stage);
        await rename(stage, database);
        syncDirectory(folder.dir);
      }
      if (!(await lstat(database)).isDirectory()) throw new Error("incomplete manager database directory");
      if ((await readFile(join(database, "PG_VERSION"), "utf8")).trim() !== "18")
        throw new Error("incompatible manager engine format");
      client = await PGlite.create({ ...options, fs: new DurableFilesystem(database) });
    } else client = await PGlite.create({ ...options, loadDataDir: archive });
    await migrateDatabase(client, migrations, "pocketcoder_manager");
    const db = drizzle({ client });
    let closed = false;
    const database = client;
    return {
      db,
      client: database,
      tables: managerSchema("pocketcoder_manager"),
      validate: () => folder?.validate(),
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
export type ManagerContext = Awaited<ReturnType<typeof managerContext>>;
