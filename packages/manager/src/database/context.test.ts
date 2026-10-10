import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGliteStore } from "@pstdio/pocketcoder-db";
import { managerContext } from "./context";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "pc-manager-format-"));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
test("core refuses manager data before adding a core schema", async () => {
  const path = await directory();
  const manager = await managerContext(path);
  await manager.close();
  await expect(PGliteStore.create(path)).rejects.toThrow("format");
  const reopened = await managerContext(path);
  cleanups.push(() => reopened.close());
  expect(
    (await reopened.client.query("select schema_name from information_schema.schemata where schema_name='pocketcoder'"))
      .rows,
  ).toEqual([]);
});
test("manager refuses core data without changing it", async () => {
  const path = await directory();
  const core = await PGliteStore.create(path);
  await core.close();
  await expect(managerContext(path)).rejects.toThrow("not manager data");
  const reopened = await PGliteStore.create(path);
  cleanups.push(() => reopened.close());
});
test("manager rejects a redirected database and an empty folder argument", async () => {
  const path = await directory();
  const manager = await managerContext(path);
  await manager.close();
  await rename(join(path, "db"), join(path, "outside"));
  await symlink(join(path, "outside"), join(path, "db"));
  await expect(managerContext(path)).rejects.toThrow("database directory");
  await expect(managerContext("")).rejects.toThrow("empty");
});
