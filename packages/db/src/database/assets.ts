/// <reference path="./file-types.d.ts" />
import { createHash } from "node:crypto";
import manifest from "../../assets/core-seed.json" with { type: "json" };
import seedPath from "../../assets/core-seed.tar.gz" with { type: "file" };
import migrations from "../../assets/migrations.json" with { type: "json" };
import bundlePath from "../../node_modules/@electric-sql/pglite/dist/pglite.data" with { type: "file" };
import wasmPath from "../../node_modules/@electric-sql/pglite/dist/pglite.wasm" with { type: "file" };
import { dependencies } from "../../package.json" with { type: "json" };

let assets: Promise<{ pgliteWasmModule: WebAssembly.Module; fsBundle: Blob; loadDataDir: Blob }> | undefined;

export function loadCoreAssets() {
  assets ??= (async () => {
    const seed = await Bun.file(new URL(seedPath, import.meta.url)).arrayBuffer();
    if (manifest.app !== "pocketcoder" || manifest.pgliteVersion !== dependencies["@electric-sql/pglite"])
      throw new Error("incompatible core seed");
    if (createHash("sha256").update(new Uint8Array(seed)).digest("hex") !== manifest.checksum)
      throw new Error("core seed checksum drift");
    for (const migration of migrations) {
      const checksum = createHash("sha256").update(migration.sql.join("--> statement-breakpoint")).digest("hex");
      if (checksum !== migration.hash) throw new Error(`embedded migration checksum drift: ${migration.name}`);
    }
    const registry = migrations.map(({ name, hash }) => ({ name, hash }));
    if (JSON.stringify(registry) !== JSON.stringify(manifest.migrations))
      throw new Error("core seed migration drift; run bun run db:seed");
    return {
      pgliteWasmModule: await WebAssembly.compile(await Bun.file(new URL(wasmPath, import.meta.url)).arrayBuffer()),
      fsBundle: Bun.file(new URL(bundlePath, import.meta.url)),
      loadDataDir: new Blob([seed]),
    };
  })();
  return assets;
}
