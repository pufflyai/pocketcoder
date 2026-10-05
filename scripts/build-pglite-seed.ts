import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { dependencies } from "../packages/db/package.json" with { type: "json" };

const root = resolve(import.meta.dir, "..");
const assets = resolve(root, "packages/db/assets");
const migrations = readMigrationFiles({ migrationsFolder: resolve(root, "packages/db/drizzle") });
const registry = migrations.map(({ name, hash }) => ({ name, hash }));

if (process.argv.includes("--check")) {
  const saved = await Bun.file(resolve(assets, "migrations.json")).json();
  if (JSON.stringify(saved) !== JSON.stringify(migrations))
    throw new Error("embedded migrations are stale; run bun run db:seed");
  const manifest = await Bun.file(resolve(assets, "core-seed.json")).json();
  if (
    manifest.app !== "pocketcoder" ||
    manifest.pgliteVersion !== dependencies["@electric-sql/pglite"] ||
    JSON.stringify(manifest.migrations) !== JSON.stringify(registry)
  )
    throw new Error("core seed manifest is stale; run bun run db:seed");
  const bytes = new Uint8Array(await Bun.file(resolve(assets, "core-seed.tar.gz")).arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== manifest.checksum)
    throw new Error("core seed checksum drift");
  console.log("Embedded core assets match the generated migrations and engine.");
} else {
  await mkdir(assets, { recursive: true });
  await writeFile(resolve(assets, "migrations.json"), `${JSON.stringify(migrations, null, 2)}\n`);
  const { migrateDatabase, getMigrationStatus } = await import("../packages/db/src/migrations/migrator");
  const client = await PGlite.create({ postgresqlconf: ["shared_buffers = 16MB"], relaxedDurability: false });
  try {
    await migrateDatabase(client);
    const status = await getMigrationStatus(client);
    if (status.some((migration) => !migration.appliedAt || migration.drifted))
      throw new Error("seed migrations are invalid");
    const seed = new Uint8Array(await (await client.dumpDataDir("gzip")).arrayBuffer());
    const manifest = {
      app: "pocketcoder",
      pgliteVersion: dependencies["@electric-sql/pglite"],
      postgresVersion: (await client.query<{ server_version: string }>("SHOW server_version")).rows[0]?.server_version,
      checksum: createHash("sha256").update(seed).digest("hex"),
      migrations: registry,
    };
    await writeFile(resolve(assets, "core-seed.tar.gz.tmp"), seed);
    await rename(resolve(assets, "core-seed.tar.gz.tmp"), resolve(assets, "core-seed.tar.gz"));
    await writeFile(resolve(assets, "core-seed.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Built core seed (${seed.byteLength} bytes, ${status.length} migrations)`);
  } finally {
    await client.close();
  }
}
