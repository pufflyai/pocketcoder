import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOperatorBundle } from "./bundle";

test("the deployed manager bundle runs outside the source checkout with no workspace dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc103-bundle-"));
  try {
    const release = await buildOperatorBundle(join(root, "bundle"));
    const extract = join(root, "installed");
    const unpack = Bun.spawn(["tar", "-xzf", release.path, "-C", root], { stdout: "pipe", stderr: "pipe" });
    expect(await unpack.exited).toBe(0);
    const child = Bun.spawn(
      [process.execPath, join(extract, "index.js"), "operator", new Date(Date.now() + 3600_000).toISOString()],
      {
        cwd: root,
        env: { PATH: process.env.PATH, POCKETCODER_MANAGER_DIR: join(root, "manager") },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const output = await new Response(child.stdout).text();
    const error = await new Response(child.stderr).text();
    expect(await child.exited, error).toBe(0);
    expect(JSON.parse(output).token.length).toBeGreaterThan(30);
    expect(release.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await Bun.file(join(extract, "run-manager-backup.js")).exists()).toBe(true);
    expect(await Bun.file(join(extract, "run-account-backups.js")).exists()).toBe(true);
    expect((await buildOperatorBundle(join(root, "repeated"))).sha256).toBe(release.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
