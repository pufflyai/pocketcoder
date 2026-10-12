import { constants, zstdDecompressSync } from "node:zlib";

export function decodeDatabaseAsset(bytes: Uint8Array | ArrayBuffer) {
  return zstdDecompressSync(bytes, {
    params: { [constants.ZSTD_d_windowLogMax]: 24 },
  });
}
