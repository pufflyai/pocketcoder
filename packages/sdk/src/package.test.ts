import { expect, test } from "bun:test";
import { join } from "node:path";

test("publishes built Node ESM and bundled declarations", async () => {
  const manifest = await Bun.file(join(import.meta.dir, "../package.json")).json();

  expect(manifest).toMatchObject({
    name: "@pstdio/pocketcoder-sdk",
    private: false,
    type: "module",
    files: ["dist", "README.md", "LICENSE"],
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
    },
    publishConfig: { access: "public" },
    engines: { node: ">=22.19.0" },
  });
  expect(manifest.dependencies ?? {}).not.toHaveProperty("@pstdio/pocketcoder-contracts");
});
