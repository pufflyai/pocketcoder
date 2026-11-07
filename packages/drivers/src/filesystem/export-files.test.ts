import { expect, test } from "bun:test";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readExportFiles } from "./export-files";

test("trusted extraction confines regular files and enforces aggregate bounds", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc131-exports-"));
  try {
    const mount = join(root, "outputs");
    await mkdir(mount);
    await writeFile(join(mount, "result.csv"), "a,b\n1,2\n");
    await writeFile(join(root, "secret"), "private");
    await symlink(join(root, "secret"), join(mount, "escape"));
    await link(join(root, "secret"), join(mount, "alias"));
    const result = await readExportFiles(root, ["outputs"], { bytes: 8, files: 1 }, AbortSignal.timeout(1000));
    expect(result.files.map((file) => file.name)).toEqual(["outputs/result.csv"]);
    expect(Buffer.from(result.files[0]!.bytes).toString()).toBe("a,b\n1,2\n");
    expect(result.errors).toContain("unsafe_file");
    const bounded = await readExportFiles(root, ["outputs"], { bytes: 1, files: 1 }, AbortSignal.timeout(1000));
    expect(bounded.files).toEqual([]);
    expect(bounded.errors).toContain("export_limit");
    await expect(readExportFiles(root, ["../"], { bytes: 8, files: 1 }, AbortSignal.timeout(1000))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing storage and cancelled extraction never become successful empty output", async () => {
  const result = await readExportFiles(
    "/does-not-exist",
    ["outputs"],
    { bytes: 8, files: 1 },
    AbortSignal.timeout(1000),
  );
  expect(result.errors).toEqual(["storage_unavailable"]);
  await expect(readExportFiles("/tmp", [], { bytes: 8, files: 1 }, AbortSignal.abort())).rejects.toThrow();
});
