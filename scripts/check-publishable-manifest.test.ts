import { expect, test } from "bun:test";
import { assertNoLocalInstallDependencies, assertWorkspaceInstallDependencies } from "./check-publishable-manifest";

const workspaces = new Map([
  ["sdk", { version: "1.2.3" }],
  ["internal", { version: "1.0.0", private: true }],
]);

test("rejects local-only ranges that would reach package consumers", () => {
  expect(() =>
    assertNoLocalInstallDependencies({
      dependencies: { runtime: "workspace:^" },
      optionalDependencies: { optional: "catalog:shared" },
      peerDependencies: { peer: "file:../peer" },
    }),
  ).toThrow("local-only install dependencies");
});

test.each(["../runtime", "C:\\runtime"])("rejects bare filesystem range %s", (range) => {
  expect(() => assertNoLocalInstallDependencies({ dependencies: { runtime: range } })).toThrow(
    "local-only install dependencies",
  );
});

test("accepts compatible public dependencies and local development dependencies", () => {
  const manifest = {
    dependencies: { sdk: "^1.2.0", external: "^2.0.0" },
    devDependencies: { internal: "workspace:*" },
  };
  expect(() => assertNoLocalInstallDependencies(manifest)).not.toThrow();
  expect(() => assertWorkspaceInstallDependencies(manifest, workspaces)).not.toThrow();
});

test("rejects an incompatible SDK range before consumer overrides can hide it", () => {
  expect(() => assertWorkspaceInstallDependencies({ dependencies: { sdk: "^2.0.0" } }, workspaces)).toThrow(
    "does not accept workspace version",
  );
});

test("rejects non-version declarations before consumer overrides can hide them", () => {
  expect(() => assertWorkspaceInstallDependencies({ dependencies: { sdk: "banana" } }, workspaces)).toThrow(
    "is not a semantic version range",
  );
});

test("rejects private workspace dependencies even when their version range is valid", () => {
  expect(() => assertWorkspaceInstallDependencies({ dependencies: { internal: "^1.0.0" } }, workspaces)).toThrow(
    "refers to a private workspace",
  );
});
