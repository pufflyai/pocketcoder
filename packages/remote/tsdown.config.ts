import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/bin.ts", "src/extension.ts"],
  clean: true,
  deps: {
    neverBundle: [
      "@earendil-works/pi-ai",
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-tui",
      "@pstdio/pocketcoder-sdk",
    ],
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
