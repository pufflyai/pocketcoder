import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPackedDependencies } from "./check-sdk-package";

async function packFixture(root: string, name: string, source: string, dependencies = {}) {
  const directory = join(root, name);
  await Bun.write(
    join(directory, "package.json"),
    JSON.stringify({
      name,
      version: "9999.0.0",
      type: "module",
      exports: "./index.ts",
      dependencies,
    }),
  );
  await Bun.write(join(directory, "index.ts"), source);
  const child = Bun.spawn(
    [process.execPath, "pm", "pack", "--filename", "fixture.tgz", "--ignore-scripts", "--quiet"],
    { cwd: directory, stdout: "pipe", stderr: "pipe" },
  );
  expect(await child.exited).toBe(0);
  return join(directory, "fixture.tgz");
}

test("consumer installs share the packed SDK before its version exists on npm", async () => {
  const root = await mkdtemp(join(tmpdir(), "pocketcoder-unpublished-consumer-"));
  try {
    const sdk = await packFixture(root, "@pstdio/pocketcoder-sdk", "export const identity = {};");
    const remote = await packFixture(
      root,
      "@pstdio/pocketcoder-remote",
      'export { identity } from "@pstdio/pocketcoder-sdk";',
      { "@pstdio/pocketcoder-sdk": "^9999.0.0" },
    );
    const consumer = join(root, "consumer");
    await installPackedDependencies(consumer, {
      "@pstdio/pocketcoder-sdk": sdk,
      "@pstdio/pocketcoder-remote": remote,
    });
    await Bun.write(
      join(consumer, "verify.ts"),
      `import { strictEqual } from "node:assert";
import { identity as sdk } from "@pstdio/pocketcoder-sdk";
import { identity as remote } from "@pstdio/pocketcoder-remote";
strictEqual(sdk, remote);
console.log("Shared packed SDK");
`,
    );
    const child = Bun.spawn([process.execPath, "verify.ts"], {
      cwd: consumer,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(stdout).toContain("Shared packed SDK");
    expect(code).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
