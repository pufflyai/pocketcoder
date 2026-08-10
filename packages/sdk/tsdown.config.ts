import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  alias: {
    "@pstdio/pocketcoder-contracts": fileURLToPath(
      new URL("../contracts/src/index.ts", import.meta.url),
    ),
  },
  clean: true,
  deps: {
    neverBundle: ["zod"],
  },
  dts: {
    eager: true,
    resolver: "tsc",
  },
  fixedExtension: false,
  format: ["esm"],
  outDir: "dist",
  platform: "node",
  target: "node22",
});
