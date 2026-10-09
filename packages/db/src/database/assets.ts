/// <reference path="./file-types.d.ts" />
import { createHash } from "node:crypto";
import { brotliDecompressSync } from "node:zlib";
import manifest from "../../assets/core-seed.json" with { type: "json" };
import seedPath from "../../assets/core-seed.tar.br" with { type: "file" };
import migrations from "../../assets/migrations.json" with { type: "json" };
import bundlePath from "../../assets/pglite.data.br" with { type: "file" };
import wasmPath from "../../assets/pglite.wasm.br" with { type: "file" };
import { dependencies } from "../../package.json" with { type: "json" };

let assets:
  | Promise<{ pgliteWasmModule: WebAssembly.Module; fsBundle: Blob; loadDataDir: Blob; memorySeed: () => Blob }>
  | undefined;

async function unpack(path: string, checksum: string, name: string) {
  const bytes = await Bun.file(new URL(path, import.meta.url)).arrayBuffer();
  if (createHash("sha256").update(new Uint8Array(bytes)).digest("hex") !== checksum)
    throw new Error(`${name} checksum drift`);
  return brotliDecompressSync(bytes);
}

export function loadCoreAssets() {
  assets ??= (async () => {
    if (manifest.app !== "pocketcoder" || manifest.pgliteVersion !== dependencies["@electric-sql/pglite"])
      throw new Error("incompatible core seed");
    for (const migration of migrations) {
      const checksum = createHash("sha256").update(migration.sql.join("--> statement-breakpoint")).digest("hex");
      if (checksum !== migration.hash) throw new Error(`embedded migration checksum drift: ${migration.name}`);
    }
    const registry = migrations.map(({ name, hash }) => ({ name, hash }));
    if (JSON.stringify(registry) !== JSON.stringify(manifest.migrations))
      throw new Error("core seed migration drift; run bun run db:seed");
    const seed = Bun.gzipSync(await unpack(seedPath, manifest.checksum, "core seed"));
    let memorySeed: Blob | undefined;
    return {
      pgliteWasmModule: await WebAssembly.compile(await unpack(wasmPath, manifest.engine.wasm.checksum, "core WASM")),
      fsBundle: new Blob([await unpack(bundlePath, manifest.engine.data.checksum, "core data")]),
      // Disk controllers keep the small archive; only memory stores need a shared inflated copy.
      loadDataDir: new Blob([seed]),
      // Engines copy this immutable archive into their own filesystems.
      memorySeed: () => (memorySeed ??= new Blob([Bun.gunzipSync(seed)], { type: "application/x-tar" })),
    };
  })();
  return assets;
}
