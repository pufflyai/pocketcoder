import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkShippedMigrations } from "./check-migrations";

async function folder(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "pc-migrations-"));
  for (const [name, sql] of Object.entries(files)) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, "migration.sql"), sql);
  }
  return root;
}

const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

test("shipped migrations may not change or disappear; new ones are free", async () => {
  const shipped = { first: { hash: sha("create a"), release: "v1" }, second: { hash: sha("create b"), release: "v1" } };
  const unchanged = await folder({ first: "create a", second: "create b", third: "create c" });
  const edited = await folder({ first: "create a -- edited", second: "create b" });
  const removed = await folder({ first: "create a" });
  try {
    expect(await checkShippedMigrations(unchanged, shipped, {})).toEqual([]);
    expect(await checkShippedMigrations(edited, shipped, {})).toEqual(["first (v1) changed after it shipped"]);
    expect(await checkShippedMigrations(removed, shipped, {})).toEqual(["second (v1) was removed after it shipped"]);
    // An upgrade step that reconciles a shipped migration may stand in for it.
    expect(await checkShippedMigrations(removed, shipped, { second: "first" })).toEqual([]);
  } finally {
    for (const root of [unchanged, edited, removed]) await rm(root, { recursive: true, force: true });
  }
});
