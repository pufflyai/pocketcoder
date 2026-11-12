import { beforeAll, expect, test } from "bun:test";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareLabSdk } from "./prepare-sdk";

const repo = resolve(import.meta.dir, "../../..");
beforeAll(async () => {
  const child = Bun.spawn([process.execPath, "run", "--cwd", join(repo, "packages/sdk"), "build"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code, out + err).toBe(0);
}, 60_000);

test("the Lab SDK loads outside the workspace with no dependency links", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc-lab-sdk-"));
  const target = join(directory, "sdk");
  try {
    await prepareLabSdk(join(repo, "packages/sdk"), target);
    expect((await lstat(target)).isSymbolicLink()).toBe(false);
    const source = `import { PocketCoderClient, managed } from ${JSON.stringify(join(target, "dist/index.js"))};
      console.log(typeof PocketCoderClient, managed.ProfileConfigSchema.parse({template:"echo"}).template);`;
    const child = Bun.spawn([process.execPath, "--no-install", "--eval", source], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, err).toBe(0);
    expect(out.trim()).toBe("function echo");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
