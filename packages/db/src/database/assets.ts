/// <reference path="./file-types.d.ts" />
import { createHash } from "node:crypto";
import { brotliDecompressSync } from "node:zlib";
import manifest from "../../assets/core-seed.json" with { type: "json" };
import seedPath from "../../assets/core-seed.tar.br" with { type: "file" };
import migrations from "../../assets/migrations.json" with { type: "json" };
import { dependencies } from "../../package.json" with { type: "json" };

import { loadDatabaseEngine } from "./engine-assets";

let assets: ReturnType<typeof createCoreAssets> | undefined;

async function readSeed() {
  const bytes = await Bun.file(new URL(seedPath, import.meta.url)).bytes();
  if (createHash("sha256").update(bytes).digest("hex") !== manifest.checksum)
    throw new Error("core seed checksum drift");
  return bytes;
}

async function createCoreAssets() {
  if (manifest.app !== "pocketcoder" || manifest.pgliteVersion !== dependencies["@electric-sql/pglite"])
    throw new Error("incompatible core seed");
  for (const migration of migrations) {
    const checksum = createHash("sha256").update(migration.sql.join("--> statement-breakpoint")).digest("hex");
    if (checksum !== migration.hash) throw new Error(`embedded migration checksum drift: ${migration.name}`);
  }
  const registry = migrations.map(({ name, hash }) => ({ name, hash }));
  if (JSON.stringify(registry) !== JSON.stringify(manifest.migrations))
    throw new Error("core seed migration drift; run bun run db:seed");
  const seed = await readSeed();
  // Existing disk databases need only the verified compressed bytes. Fresh installs
  // release their raw archive after extraction; memory stores share their immutable Blob.
  const seedArchive = () => brotliDecompressSync(seed);
  let memorySeed: Blob | undefined;
  return {
    ...(await loadDatabaseEngine()),
    seedArchive,
    memorySeed: () => (memorySeed ??= new Blob([seedArchive()], { type: "application/x-tar" })),
  };
}

export function loadCoreAssets() {
  assets ??= createCoreAssets();
  return assets;
}
