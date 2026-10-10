import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncSeed } from "./data-folder";

test("seed sync makes every nested seed directory and file private", async () => {
  const seed = await mkdtemp(join(tmpdir(), "pc-seed-sync-"));
  try {
    await mkdir(join(seed, "base", "1"), { recursive: true, mode: 0o755 });
    await writeFile(join(seed, "PG_VERSION"), "18\n", { mode: 0o644 });
    await writeFile(join(seed, "base", "1", "1259"), "catalog", { mode: 0o644 });
    await syncSeed(seed);
    for (const directory of [seed, join(seed, "base"), join(seed, "base", "1")])
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    for (const file of [join(seed, "PG_VERSION"), join(seed, "base", "1", "1259")])
      expect((await stat(file)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(seed, { recursive: true, force: true });
  }
});

test("a refused seed link stops all seed sync work before the failure returns", async () => {
  const seed = await mkdtemp(join(tmpdir(), "pc-seed-link-"));
  try {
    const files = Array.from({ length: 500 }, (_, index) => join(seed, `file-${index}`));
    for (const file of files) await writeFile(file, "x", { mode: 0o644 });
    await symlink(files[0] ?? "", join(seed, "link"));
    await expect(syncSeed(seed)).rejects.toThrow();
    const privateFiles = async () =>
      (await Promise.all(files.map((file) => stat(file)))).filter((s) => (s.mode & 0o777) === 0o600).length;
    const settled = await privateFiles();
    await Bun.sleep(100);
    expect(await privateFiles()).toBe(settled);
  } finally {
    await rm(seed, { recursive: true, force: true });
  }
});
