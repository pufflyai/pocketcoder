import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("startup generation refuses private input in another repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc103-private-input-"));
  try {
    const repository = join(root, "repository");
    await mkdir(repository);
    const git = Bun.spawn(["git", "init", repository], { stdout: "pipe", stderr: "pipe" });
    expect(await git.exited).toBe(0);
    const input = join(repository, "private.json");
    await writeFile(input, "{}", { mode: 0o600 });
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "write-cloud-init.ts"), input, join(root, "operator", "startup.yaml")],
      { stdout: "pipe", stderr: "pipe" },
    );
    const error = await new Response(child.stderr).text();
    expect(await child.exited).not.toBe(0);
    expect(error).toContain("outside repositories and workspaces");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
