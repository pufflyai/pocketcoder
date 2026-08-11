import { expect, test } from "bun:test";
import { join } from "node:path";

test("publishes the typed extension subpath with only public runtime dependencies", async () => {
  const manifest = await Bun.file(join(import.meta.dir, "../package.json")).json();

  expect(manifest).toMatchObject({
    name: "@pstdio/pocketcoder-remote",
    private: false,
    type: "module",
    files: ["dist", "README.md", "LICENSE"],
    exports: {
      "./extension": {
        types: "./dist/extension.d.ts",
        import: "./dist/extension.js",
      },
    },
    dependencies: {
      "@pstdio/pocketcoder-sdk": "workspace:^",
    },
  });
  expect(manifest.dependencies).not.toHaveProperty("@pstdio/pocketcoder-contracts");
  expect(manifest.devDependencies).not.toHaveProperty("@pstdio/pocketcoder-contracts");
});
