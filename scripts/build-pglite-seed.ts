import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { constants, zstdCompressSync } from "node:zlib";
import { PGlite } from "@electric-sql/pglite";
import { decodeDatabaseAsset } from "@pstdio/pocketcoder-db/asset-codec";
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
  const compressed = zstdCompressSync(bytes, {
    params: {
      [constants.ZSTD_c_compressionLevel]: 19,
      // Bound decoding memory without changing the database pages.
      [constants.ZSTD_c_windowLog]: 24,
    },
  });
  if (checksum(decodeDatabaseAsset(compressed)) !== checksum(bytes))
    throw new Error(`database asset compression changed bytes: ${name}`);
  const path = resolve(assets, name);
  await writeFile(`${path}.tmp`, compressed);
  await rename(`${path}.tmp`, path);
  return { checksum: checksum(compressed), sourceChecksum: checksum(bytes) };
}

function engineFile(extension: string) {
  return Bun.file(resolve(root, `packages/db/node_modules/@electric-sql/pglite/dist/pglite.${extension}`));
}

// PGlite only dumps a running cluster, and every new database would recover that
// dump as a crash: replay its WAL and fsync each file again. A stopped cluster opens directly.
async function buildStoppedCluster(directory: string) {
  const { migrateDatabase, getMigrationStatus } = await import("../packages/db/src/migrations/migrator");
  const client = await PGlite.create({
    dataDir: directory,
    postgresqlconf: ["shared_buffers = 16MB"],
    relaxedDurability: false,
  });
  try {
    await migrateDatabase(client);
    const status = await getMigrationStatus(client);
    if (status.some((migration) => !migration.appliedAt || migration.drifted))
      throw new Error("seed migrations are invalid");
    const version = await client.query<{ server_version: string }>("SHOW server_version");
    return { postgresVersion: version.rows[0]?.server_version };
  } finally {
    await client.close();
  }
}

function octal(value: number, width: number) {
  return `${value.toString(8).padStart(width, "0")}\0`;
}

// Same ustar layout as a PGlite dump, so both the memory loader and disk extraction accept it.
function tarHeader(name: string, mode: number, size: number, mtimeMs: number, directory: boolean) {
  if (Buffer.byteLength(name) > 100) throw new Error(`seed path is too long for ustar: ${name}`);
  const header = Buffer.alloc(512);
  header.write(name, 0);
  header.write(octal(mode, 7), 100);
  header.write(octal(0, 7), 108);
  header.write(octal(0, 7), 116);
  header.write(octal(size, 11), 124);
  header.write(octal(Math.floor(mtimeMs / 1000), 11), 136);
  header.write(directory ? "5" : "0", 156);
  header.write("ustar\u000000", 257);
  header.fill(" ", 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return header;
}

async function tarDirectory(root: string) {
  const blocks: Uint8Array[] = [];
  async function add(path: string) {
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      const name = `${path}/${entry.name}`;
      const info = await stat(join(root, name));
      const data = entry.isDirectory() ? new Uint8Array() : await Bun.file(join(root, name)).bytes();
      blocks.push(tarHeader(name, info.mode & 0o777, data.length, info.mtimeMs, entry.isDirectory()));
      blocks.push(data, new Uint8Array((512 - (data.length % 512)) % 512));
      if (entry.isDirectory()) await add(name);
    }
  }
  await add("");
  blocks.push(new Uint8Array(1024));
  return Buffer.concat(blocks);
}

if (process.argv.includes("--recompress-seed")) {
  const path = resolve(assets, "core-seed.json");
  const manifest = await Bun.file(path).json();
  const compressed = await Bun.file(resolve(assets, "core-seed.tar.zst")).bytes();
  if (checksum(compressed) !== manifest.checksum) throw new Error("core seed checksum drift");
  const seed = decodeDatabaseAsset(compressed);
  if (checksum(seed) !== manifest.sourceChecksum) throw new Error("core seed raw checksum drift");
  const result = await embed("core-seed.tar.zst", seed);
  const restored = decodeDatabaseAsset(await Bun.file(resolve(assets, "core-seed.tar.zst")).bytes());
  if (checksum(seed) !== checksum(restored)) throw new Error("core seed recompression changed database bytes");
  await writeFile(path, `${JSON.stringify({ ...manifest, checksum: result.checksum }, null, 2)}\n`);
  console.log(JSON.stringify({ sourceChecksum: checksum(seed), restoredChecksum: checksum(restored) }));
} else if (process.argv.includes("--check")) {
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
  const bytes = new Uint8Array(await Bun.file(resolve(assets, "core-seed.tar.zst")).arrayBuffer());
  if (checksum(bytes) !== manifest.checksum || checksum(decodeDatabaseAsset(bytes)) !== manifest.sourceChecksum)
    throw new Error("core seed checksum drift");
  for (const extension of ["wasm", "data"] as const) {
    const compressed = new Uint8Array(await Bun.file(resolve(assets, `pglite.${extension}.zst`)).arrayBuffer());
    const source = new Uint8Array(await engineFile(extension).arrayBuffer());
    if (
      checksum(compressed) !== manifest.engine[extension].checksum ||
      checksum(source) !== manifest.engine[extension].sourceChecksum ||
      checksum(decodeDatabaseAsset(compressed)) !== checksum(source)
    )
      throw new Error(`embedded core ${extension} drift; run bun run db:seed`);
  }
  console.log("Embedded core assets match the generated migrations and engine.");
} else {
  await mkdir(assets, { recursive: true });
  await writeFile(resolve(assets, "migrations.json"), `${JSON.stringify(migrations, null, 2)}\n`);
  const directory = await mkdtemp(join(tmpdir(), "pocketcoder-seed-"));
  try {
    const { postgresVersion } = await buildStoppedCluster(directory);
    const seed = await tarDirectory(directory);
    const embeddedSeed = await embed("core-seed.tar.zst", seed);
    const engine = {
      wasm: await embed("pglite.wasm.zst", new Uint8Array(await engineFile("wasm").arrayBuffer())),
      data: await embed("pglite.data.zst", new Uint8Array(await engineFile("data").arrayBuffer())),
    };
    const manifest = {
      app: "pocketcoder",
      pgliteVersion: dependencies["@electric-sql/pglite"],
      postgresVersion,
      checksum: embeddedSeed.checksum,
      sourceChecksum: embeddedSeed.sourceChecksum,
      engine,
      migrations: registry,
    };
    await writeFile(resolve(assets, "core-seed.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Built core seed (${seed.byteLength} bytes, ${registry.length} migrations)`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
