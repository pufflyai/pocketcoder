import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directory } from "./projection-paths";

test("concurrent publishers can create shared parents while symlink substitutions still fail", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc129-directory-")));
  try {
    const path = join(root, "shared", "nested");
    await Promise.all(Array.from({ length: 20 }, () => directory(path)));
    await symlink(path, join(root, "alias"));
    await expect(directory(join(root, "alias", "new"))).rejects.toThrow("links");
    expect(await Bun.file(join(root, "alias", "new")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
