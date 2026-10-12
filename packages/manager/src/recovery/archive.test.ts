import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArchiveOutput } from "@pstdio/pocketcoder-db/backup";
import { managerContext } from "../database/context";
import { readManagerArchive, writeManagerArchive } from "./archive";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pc102-archive-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const operationId = randomUUID();
  const directory = join(root, operationId);
  await mkdir(directory, { mode: 0o700 });
  return { root, directory, operationId };
}
test("a physical manager snapshot verifies its own schema, seed and file inventory", async () => {
  const f = await fixture();
  const context = await managerContext(join(f.root, "source"));
  cleanups.push(() => context.close());
  const journal = { journalId: randomUUID(), sequence: 0, digest: "a".repeat(64) };
  const output = await writeManagerArchive(
    context,
    journal,
    join(f.directory, "plain.tar"),
    128 * 1024 ** 2,
    f.operationId,
  );
  expect(await readManagerArchive(output.path)).toEqual(output.manifest);
  expect(output.manifest.app).toBe("pocketcoder-manager");
  expect(output.manifest.members.every((member) => member.path === "db" || member.path.startsWith("db/"))).toBe(true);
  const bytes = await readFile(output.path);
  const changed = Buffer.from(bytes);
  changed[1024] = (changed[1024] ?? 0) ^ 1;
  const corrupt = join(f.directory, "corrupt.tar");
  await writeFile(corrupt, changed, { mode: 0o600 });
  await expect(readManagerArchive(corrupt)).rejects.toThrow();
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(output.digest.slice(7));
});
for (const path of ["db/../outside", "db/missing/file", "outside"]) {
  test(`manager restore refuses ${path} before writing a member`, async () => {
    const f = await fixture();
    const output = createArchiveOutput(join(f.directory, "unsafe.tar"), [], () => {});
    try {
      await output.directory("db");
      await output.file(
        path,
        1,
        (async function* () {
          yield Buffer.from("x");
        })(),
      );
      await output.publish();
      const extracted = join(f.directory, "extracted");
      await mkdir(extracted, { mode: 0o700 });
      await expect(readManagerArchive(output.path, extracted)).rejects.toThrow("Manager archive");
    } finally {
      output.discard();
    }
  });
}
