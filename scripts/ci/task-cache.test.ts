import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { exportTaskCache, importTaskCache } from "./task-cache";

test("trusted Nx outputs survive a fresh runner database and still invalidate on source changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc142-nx-"));
  async function run() {
    const child = Bun.spawn(["bun", "x", "nx", "run", "demo:typecheck"], {
      cwd: root,
      env: {
        ...process.env,
        NX_DAEMON: "false",
        NX_LOAD_DOT_ENV_FILES: "false",
        NX_CACHE_DIRECTORY: join(root, ".nx/cache"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, error).toBe(0);
    return output;
  }
  try {
    await mkdir(join(root, "packages/demo"), { recursive: true });
    await symlink(resolve(import.meta.dir, "../../node_modules"), join(root, "node_modules"));
    await Bun.write(join(root, "package.json"), JSON.stringify({ private: true, workspaces: ["packages/*"] }));
    await Bun.write(join(root, "nx.json"), JSON.stringify({ targetDefaults: { typecheck: { cache: true } } }));
    await Bun.write(
      join(root, "packages/demo/package.json"),
      JSON.stringify({ name: "demo", scripts: { typecheck: 'bun -e "console.log(123)"' } }),
    );
    await run();
    await exportTaskCache(root);
    await rm(join(root, ".nx/workspace-data"), { recursive: true, force: true });
    await importTaskCache(root);
    expect(await run()).toContain("1 out of 1 tasks");
    await Bun.write(join(root, "packages/demo/source.ts"), "export const changed = true;\n");
    expect(await run()).not.toContain("1 out of 1 tasks");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
