import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { brotliCompressSync } from "node:zlib";
import { PGlite } from "@electric-sql/pglite";
import { migrateDatabase } from "@pstdio/pocketcoder-db/engine";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { dependencies } from "../package.json" with { type: "json" };

const root = resolve(import.meta.dir, "..");
const assets = join(root, "assets");
const migrations = readMigrationFiles({ migrationsFolder: join(root, "drizzle") });
const registry = migrations.map(({ name, hash }) => ({ name, hash }));
const checksum = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
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

if (process.argv.includes("--check")) {
  const manifest = await Bun.file(join(assets, "manager-seed.json")).json();
  if (
    manifest.app !== "pocketcoder-manager" ||
    manifest.pgliteVersion !== dependencies["@electric-sql/pglite"] ||
    JSON.stringify(manifest.migrations) !== JSON.stringify(registry) ||
    JSON.stringify(await Bun.file(join(assets, "migrations.json")).json()) !== JSON.stringify(migrations)
  )
    throw new Error("stale manager seed; run bun run manager:seed");
  if (checksum(await Bun.file(join(assets, "manager-seed.tar.br")).bytes()) !== manifest.checksum)
    throw new Error("manager seed checksum drift");
  console.log("Manager seed matches generated migrations and engine.");
} else {
  await mkdir(assets, { recursive: true });
  const directory = await mkdtemp(join(tmpdir(), "pc-manager-seed-"));
  try {
    const client = await PGlite.create({
      dataDir: directory,
      relaxedDurability: false,
      postgresqlconf: ["shared_buffers = 16MB"],
    });
    try {
      await migrateDatabase(client, migrations, "pocketcoder_manager");
    } finally {
      await client.close();
    }
    const seed = brotliCompressSync(await tarDirectory(directory));
    await writeFile(join(assets, "manager-seed.tar.br"), seed);
    await writeFile(join(assets, "migrations.json"), `${JSON.stringify(migrations, null, 2)}\n`);
    await writeFile(
      join(assets, "manager-seed.json"),
      `${JSON.stringify({ app: "pocketcoder-manager", pgliteVersion: dependencies["@electric-sql/pglite"], migrations: registry, checksum: checksum(seed) }, null, 2)}\n`,
    );
    console.log(`Built separate manager seed (${seed.byteLength} compressed bytes)`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
