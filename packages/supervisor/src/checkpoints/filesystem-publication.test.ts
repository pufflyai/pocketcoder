import { expect, test } from "bun:test";
import { chmod, lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFilesystemCheckpointDownload } from "./filesystem-download";
import { downloadFixture } from "./filesystem-download-fixture";

async function cleanup(f: Awaited<ReturnType<typeof downloadFixture>>) {
  async function writable(path: string) {
    if (!(await lstat(path)).isDirectory()) return;
    await chmod(path, 0o700);
    for (const name of await readdir(path)) await writable(join(path, name));
  }
  await writable(f.root);
  await f.close();
}

test("verified mounts publish into disposable mount roots before runtime ownership", async () => {
  const f = await downloadFixture();
  try {
    const prepared = await createFilesystemCheckpointDownload(f.archive(), f.binding, f.mounts, f.options);
    const published = await prepared.publish();
    expect(published.map((mount) => mount.path)).toEqual([f.work, f.state]);
    expect(await readFile(join(f.work, "a"))).toEqual(f.bytes);
    expect(await readFile(join(f.work, "z", "ä"), "utf8")).toBe("nested");
    await prepared.close();
    expect((await readdir(f.work)).sort()).toEqual(["a", "deadlink", "z"]);
    expect(await readdir(f.scratch)).toEqual([]);
  } finally {
    await cleanup(f);
  }
});

test("foreign content in mount root refuses publication without overwriting it", async () => {
  const f = await downloadFixture();
  try {
    const prepared = await createFilesystemCheckpointDownload(f.archive(), f.binding, f.mounts, f.options);
    await writeFile(join(f.work, "a"), "foreign");
    await expect(prepared.publish()).rejects.toThrow();
    expect(await readFile(join(f.work, "a"), "utf8")).toBe("foreign");
    await expect(prepared.close()).rejects.toThrow();
  } finally {
    await cleanup(f);
  }
});

test("publication preserves mode-zero files and directories after content proof", async () => {
  const f = await downloadFixture();
  try {
    const entries = f.entries.map((entry) => (entry.kind === "symlink" ? entry : { ...entry, mode: 0 }));
    const archive = await f.boundArchive(entries);
    const prepared = await createFilesystemCheckpointDownload(archive.stream, archive.binding, f.mounts, f.options);
    await prepared.publish();
    expect((await lstat(join(f.work, "a"))).mode & 0o777).toBe(0);
    expect((await lstat(join(f.work, "z"))).mode & 0o777).toBe(0);
    await prepared.close();
    expect(await readdir(f.scratch)).toEqual([]);
  } finally {
    await cleanup(f);
  }
});
