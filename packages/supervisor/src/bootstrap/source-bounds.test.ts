import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifySourceBounds } from "./source-bounds";

test("source setup enforces declared byte and entry bounds without following links", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc-source-bounds-"));
  try {
    await writeFile(join(directory, "file"), "content");
    await symlink("/", join(directory, "link"));
    await expect(verifySourceBounds(directory, 8, 2)).resolves.toBeUndefined();
    await expect(verifySourceBounds(directory, 7, 2)).rejects.toThrow("byte limit");
    await expect(verifySourceBounds(directory, 100, 1)).rejects.toThrow("entry limit");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
