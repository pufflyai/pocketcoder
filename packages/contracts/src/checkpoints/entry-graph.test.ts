import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckpointArchiveEntry } from "./archive-format";
import { safeCheckpointLink } from "./archive-format";
import { validateCheckpointEntryGraph } from "./entry-graph";

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pc-checkpoint-graph-")));
  const root = join(directory, "mount");
  await mkdir(root);
  async function lookup(mount: number, path: string): Promise<CheckpointArchiveEntry | null> {
    expect(mount).toBe(0);
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(join(root, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const common = { mount, path, mode: stat.mode & 0o777, mtime_ns: "0" };
    if (stat.isDirectory()) return { ...common, kind: "directory", size: 0 };
    if (stat.isSymbolicLink()) {
      const target = await readlink(join(root, path));
      return {
        ...common,
        mode: 0o777,
        kind: "symlink",
        size: Buffer.byteLength(target),
        link_target: target,
        digest: `sha256:${createHash("sha256").update(target).digest("hex")}`,
      };
    }
    return { ...common, kind: "file", size: stat.size, digest: `sha256:${"0".repeat(64)}` };
  }
  async function entry(path: string) {
    const value = await lookup(0, path);
    if (!value) throw new Error("Missing fixture entry");
    return value;
  }
  return { directory, root, lookup, entry, close: () => rm(directory, { recursive: true, force: true }) };
}

test("rejects a real escaping link chain that passes lexical target checks", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, "root/a"), { recursive: true });
    await mkdir(join(f.root, "outside"));
    await writeFile(join(f.directory, "escape"), "outside mount");
    await symlink("../../outside", join(f.root, "root/a/link"));
    await symlink("root/a/link/../../escape", join(f.root, "alias"));
    expect(safeCheckpointLink("alias", "root/a/link/../../escape")).toBe(true);
    expect(await realpath(join(f.root, "alias"))).toBe(join(f.directory, "escape"));
    await expect(validateCheckpointEntryGraph(await f.entry("alias"), f.lookup)).rejects.toThrow("escapes");
  } finally {
    await f.close();
  }
});

test("rejects using a link as an entry parent before looking up its child", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, "actual"));
    await symlink("actual", join(f.root, "alias"));
    await writeFile(join(f.root, "actual/content"), "content");
    await expect(validateCheckpointEntryGraph(await f.entry("alias/content"), f.lookup)).rejects.toThrow("parent");
  } finally {
    await f.close();
  }
});

test("accepts safe relative chains, repeated links, and dangling targets", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, "dir"));
    await writeFile(join(f.root, "content"), "content");
    await symlink("../content", join(f.root, "dir/link"));
    await symlink("dir/link", join(f.root, "alias"));
    await symlink(".", join(f.root, "self"));
    await symlink("self/self/content", join(f.root, "repeated"));
    await symlink("missing/content", join(f.root, "dangling"));
    for (const path of ["alias", "dir/link", "repeated", "dangling"])
      await validateCheckpointEntryGraph(await f.entry(path), f.lookup);
  } finally {
    await f.close();
  }
});

test("refuses a real link cycle with bounded lookup work", async () => {
  const f = await fixture();
  try {
    await symlink("second", join(f.root, "first"));
    await symlink("first", join(f.root, "second"));
    let reads = 0;
    await expect(
      validateCheckpointEntryGraph(await f.entry("first"), async (mount, path) => {
        reads++;
        return f.lookup(mount, path);
      }),
    ).rejects.toThrow("cycle");
    expect(reads).toBeLessThanOrEqual(65);
  } finally {
    await f.close();
  }
});
