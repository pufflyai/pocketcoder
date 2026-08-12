import { expect, test } from "bun:test";
import { join } from "node:path";
import { assertNoLocalInstallDependencies } from "./check-publishable-manifest";

test("rejects local-only ranges that would reach package consumers", () => {
  const manifest = {
    name: "@pstdio/example",
    dependencies: { runtime: "workspace:^" },
    optionalDependencies: { optional: "catalog:shared" },
    peerDependencies: { peer: "file:../peer" },
  };

  expect(() => assertNoLocalInstallDependencies(manifest)).toThrow(
    "@pstdio/example has local-only install dependencies: dependencies.runtime (workspace:^), optionalDependencies.optional (catalog:shared), peerDependencies.peer (file:../peer)",
  );
});

test.each([
  "workspace:^",
  "catalog:",
  "file:../runtime",
  "link:../runtime",
  "portal:../runtime",
  "patch:runtime@1.0.0#./runtime.patch",
  "exec:./build-runtime.js",
  "git+file:../runtime",
  "../runtime",
  "/runtime",
  "~/runtime",
  "C:\\runtime",
])("rejects local dependency range %s", (range) => {
  expect(() =>
    assertNoLocalInstallDependencies({
      name: "@pstdio/example",
      dependencies: { runtime: range },
    }),
  ).toThrow(`dependencies.runtime (${range})`);
});

test("allows public dependency ranges and local development ranges", () => {
  expect(() =>
    assertNoLocalInstallDependencies({
      name: "@pstdio/example",
      dependencies: {
        runtime: "^1.0.0",
        alias: "npm:runtime@^1.0.0",
        repository: "git+https://github.com/pstdio/runtime.git#v1.0.0",
      },
      devDependencies: { bundledSource: "workspace:*" },
    }),
  ).not.toThrow();
});

test("release validates publishable manifests immediately before publishing", async () => {
  const manifest = await Bun.file(join(import.meta.dir, "../package.json")).json();

  expect(manifest.scripts.release).toBe("bun run build && bun run pack:check && changeset publish");
});

test("routine checks validate source manifests", async () => {
  const manifest = await Bun.file(join(import.meta.dir, "../package.json")).json();

  expect(manifest.scripts.check).toContain("bun run manifest:check");
  expect(manifest.scripts["manifest:check"]).toBe(
    "bun scripts/pack-publishable.ts --manifests-only",
  );
});
