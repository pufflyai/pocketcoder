import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";
import { PGlite } from "@electric-sql/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { dependencies } from "../packages/db/package.json" with { type: "json" };

const root = resolve(import.meta.dir, "..");
const assets = resolve(root, "packages/db/assets");
const migrations = readMigrationFiles({ migrationsFolder: resolve(root, "packages/db/drizzle") });
const registry = migrations.map(({ name, hash }) => ({ name, hash }));

function checksum(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function embed(name: string, bytes: Uint8Array) {
  const compressed = brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
  const path = resolve(assets, name);
  await writeFile(`${path}.tmp`, compressed);
  await rename(`${path}.tmp`, path);
  return { checksum: checksum(compressed), sourceChecksum: checksum(bytes) };
}

function engineFile(extension: string) {
  return Bun.file(resolve(root, `packages/db/node_modules/@electric-sql/pglite/dist/pglite.${extension}`));
}

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
  const bytes = new Uint8Array(await Bun.file(resolve(assets, "core-seed.tar.br")).arrayBuffer());
  if (checksum(bytes) !== manifest.checksum) throw new Error("core seed checksum drift");
  for (const extension of ["wasm", "data"] as const) {
    const compressed = new Uint8Array(await Bun.file(resolve(assets, `pglite.${extension}.br`)).arrayBuffer());
    const source = new Uint8Array(await engineFile(extension).arrayBuffer());
    if (
      checksum(compressed) !== manifest.engine[extension].checksum ||
      checksum(source) !== manifest.engine[extension].sourceChecksum
    )
      throw new Error(`embedded core ${extension} drift; run bun run db:seed`);
  }
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
    const seed = Bun.gunzipSync(await (await client.dumpDataDir("gzip")).arrayBuffer());
    const embeddedSeed = await embed("core-seed.tar.br", seed);
    const engine = {
      wasm: await embed("pglite.wasm.br", new Uint8Array(await engineFile("wasm").arrayBuffer())),
      data: await embed("pglite.data.br", new Uint8Array(await engineFile("data").arrayBuffer())),
    };
    const manifest = {
      app: "pocketcoder",
      pgliteVersion: dependencies["@electric-sql/pglite"],
      postgresVersion: (await client.query<{ server_version: string }>("SHOW server_version")).rows[0]?.server_version,
      checksum: embeddedSeed.checksum,
      engine,
      migrations: registry,
    };
    await writeFile(resolve(assets, "core-seed.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Built core seed (${seed.byteLength} bytes, ${status.length} migrations)`);
  } finally {
    await client.close();
  }
}
