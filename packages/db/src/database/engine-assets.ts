/// <reference path="./file-types.d.ts" />
import { createHash } from "node:crypto";
import manifest from "../../assets/core-seed.json" with { type: "json" };
import bundlePath from "../../assets/pglite.data.zst" with { type: "file" };
import wasmPath from "../../assets/pglite.wasm.zst" with { type: "file" };
import { dependencies } from "../../package.json" with { type: "json" };
import { decodeDatabaseAsset } from "./asset-codec";

let engine: Promise<{ pgliteWasmModule: WebAssembly.Module; fsBundle: Blob }> | undefined;
export function loadDatabaseEngine() {
  engine ??= (async () => {
    if (manifest.pgliteVersion !== dependencies["@electric-sql/pglite"])
      throw new Error("incompatible database engine");
    async function unpack(path: string, checksum: string) {
      const bytes = await Bun.file(new URL(path, import.meta.url)).arrayBuffer();
      if (createHash("sha256").update(new Uint8Array(bytes)).digest("hex") !== checksum)
        throw new Error("database engine checksum drift");
      return decodeDatabaseAsset(bytes);
    }
    return {
      pgliteWasmModule: await WebAssembly.compile(await unpack(wasmPath, manifest.engine.wasm.checksum)),
      fsBundle: new Blob([await unpack(bundlePath, manifest.engine.data.checksum)]),
    };
  })();
  return engine;
}
