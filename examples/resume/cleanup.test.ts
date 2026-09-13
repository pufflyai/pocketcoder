import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeRunDirectory } from "./cleanup";

test("removes a run containing read-only checkpoint directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "resume-cleanup-"));
  const checkpoint = join(root, "checkpoints", "snapshot");
  await mkdir(checkpoint, { recursive: true });
  const file = join(checkpoint, "saved.txt");
  await Bun.write(file, "saved");
  await chmod(file, 0o400);
  await chmod(checkpoint, 0o500);
  await removeRunDirectory(root);
  expect(await Bun.file(file).exists()).toBe(false);
});
