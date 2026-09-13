import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNoLocalInstallDependencies } from "./check-publishable-manifest";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspaceFixture(version: string, range: string, field = "dependencies") {
  const root = await mkdtemp(join(tmpdir(), "pocketcoder-release-check-"));
  fixtures.push(root);
  const remote = await Bun.file(join(import.meta.dir, "../packages/remote/package.json")).json();
  delete remote.dependencies["@pstdio/pocketcoder-sdk"];
  remote[field] = { ...remote[field], "@pstdio/pocketcoder-sdk": range };
  await Bun.write(join(root, "packages/remote/package.json"), JSON.stringify(remote));
  await Bun.write(
    join(root, "packages/sdk/package.json"),
    JSON.stringify({ name: "@pstdio/pocketcoder-sdk", version, private: false }),
  );
  await Bun.write(
    join(root, "packages/remote/src/package.test.ts"),
    Bun.file(join(import.meta.dir, "../packages/remote/src/package.test.ts")),
  );
  return root;
}

async function runFixture(
  root: string,
  args = [join(import.meta.dir, "pack-publishable.ts"), "--manifests-only"],
) {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, output: stdout + stderr };
}

test.each([
  ["0.5.1", "^0.5.0"],
  ["0.6.0", "^0.6.0"],
  ["1.0.0", "^1.0.0"],
  ["1.2.3", "~1.2.0"],
  ["2.0.0", "^1.0.0 || ^2.0.0"],
])("package checks accept compatible release %s with range %s", async (version, range) => {
  const root = await workspaceFixture(version, range);
  const manifests = await runFixture(root);
  expect(manifests.output).toContain("Publishable package manifests are valid.");
  expect(manifests.code).toBe(0);
  const packageTest = await runFixture(root, ["test", "packages/remote/src/package.test.ts"]);
  expect(packageTest.output).toContain("0 fail");
  expect(packageTest.code).toBe(0);
});

test.each(["dependencies", "optionalDependencies", "peerDependencies"])(
  "manifest checks reject incompatible workspace %s",
  async (field) => {
    const result = await runFixture(await workspaceFixture("0.5.0", "^0.4.0", field));
    expect(result.output).toContain(
      `@pstdio/pocketcoder-remote ${field}.@pstdio/pocketcoder-sdk (^0.4.0) does not accept workspace version 0.5.0`,
    );
    expect(result.code).toBe(1);
  },
);

test.each(["dependencies", "optionalDependencies", "peerDependencies"])(
  "manifest checks reject private workspace %s",
  async (field) => {
    const root = await workspaceFixture("0.5.0", "^0.5.0", field);
    await Bun.write(
      join(root, "packages/sdk/package.json"),
      JSON.stringify({ name: "@pstdio/pocketcoder-sdk", version: "0.5.0", private: true }),
    );
    const result = await runFixture(root);
    expect(result.output).toContain(
      `@pstdio/pocketcoder-remote ${field}.@pstdio/pocketcoder-sdk refers to a private workspace`,
    );
    expect(result.code).toBe(1);
  },
);

test("manifest checks allow workspace development dependencies", async () => {
  const result = await runFixture(
    await workspaceFixture("0.5.0", "workspace:*", "devDependencies"),
  );
  expect(result.output).toContain("Publishable package manifests are valid.");
  expect(result.code).toBe(0);
});

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
