import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secretTargetStore } from "./secret-targets";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

test("a file target is replaced atomically with a private file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pocketcoder-target-"));
  directories.push(directory);
  const path = join(directory, "backend-token");
  const target = secretTargetStore({ kind: "file", path });
  expect(target.describe()).toBe(`file ${path}`);
  expect(await target.read()).toBeNull();
  await target.write("pkt_first");
  expect(await target.read()).toBe("pkt_first");
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  await target.write("pkt_second");
  expect(await target.read()).toBe("pkt_second");
  expect(await readdir(directory)).toEqual(["backend-token"]);
});

test("a file target that another process loosened is rewritten private", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pocketcoder-target-"));
  directories.push(directory);
  const path = join(directory, "token");
  await writeFile(path, "stale", { mode: 0o644 });
  const target = secretTargetStore({ kind: "file", path });
  await target.write("pkt_fresh");
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});
