/// <reference path="./file-types.d.ts" />
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { constants, zstdCompressSync } from "node:zlib";
import { PGlite } from "@electric-sql/pglite";
import manifest from "../../assets/core-seed.json" with { type: "json" };
import seedPath from "../../assets/core-seed.tar.zst" with { type: "file" };
import dataPath from "../../assets/pglite.data.zst" with { type: "file" };
import wasmPath from "../../assets/pglite.wasm.zst" with { type: "file" };
import { getMigrationStatus } from "../migrations/migrator";
import { decodeDatabaseAsset } from "./asset-codec";
import { loadCoreAssets } from "./assets";

const checksum = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const engine = dirname(fileURLToPath(import.meta.resolve("@electric-sql/pglite")));
function frame(bytes: Uint8Array, windowLog = 24) {
  return zstdCompressSync(bytes, {
    params: { [constants.ZSTD_c_compressionLevel]: 19, [constants.ZSTD_c_windowLog]: windowLog },
  });
}

test("bundled bounded Zstd assets open the unchanged seeded PostgreSQL engine", async () => {
  const wasmSource = await Bun.file(join(engine, "pglite.wasm")).bytes();
  const dataSource = await Bun.file(join(engine, "pglite.data")).bytes();
  const seedSource = (await loadCoreAssets()).seedArchive();
  async function unpack(path: string, expectedChecksum: string) {
    const encoded = await Bun.file(new URL(path, import.meta.url)).bytes();
    expect(checksum(encoded)).toBe(expectedChecksum);
    return decodeDatabaseAsset(encoded);
  }
  const wasm = await unpack(wasmPath, manifest.engine.wasm.checksum);
  const data = await unpack(dataPath, manifest.engine.data.checksum);
  const seed = await unpack(seedPath, manifest.checksum);
  expect(checksum(wasmSource)).toBe(manifest.engine.wasm.sourceChecksum);
  expect(checksum(dataSource)).toBe(manifest.engine.data.sourceChecksum);
  expect(checksum(seed)).toBe(manifest.sourceChecksum);
  expect(checksum(wasm)).toBe(manifest.engine.wasm.sourceChecksum);
  expect(checksum(data)).toBe(manifest.engine.data.sourceChecksum);
  expect(checksum(seed)).toBe(checksum(seedSource));
  const client = await PGlite.create({
    pgliteWasmModule: await WebAssembly.compile(wasm),
    fsBundle: new Blob([data]),
    loadDataDir: new Blob([seed]),
    relaxedDurability: false,
    postgresqlconf: ["shared_buffers = 16MB"],
  });
  try {
    expect((await client.query<{ server_version: string }>("SHOW server_version")).rows[0]?.server_version).toBe(
      manifest.postgresVersion,
    );
    const migrations = await getMigrationStatus(client);
    expect(migrations).toHaveLength(manifest.migrations.length);
    expect(migrations.every((migration) => migration.appliedAt && !migration.drifted)).toBe(true);
  } finally {
    await client.close();
  }
});

test("the decoder refuses a frame requiring more than its 16 MiB window", async () => {
  const seed = (await loadCoreAssets()).seedArchive();
  expect(() => decodeDatabaseAsset(frame(seed, 25))).toThrow(/window|memory/i);
});
