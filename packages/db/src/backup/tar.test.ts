import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BLOCK, parseTarHeader, tarHeader, tarPadding } from "./tar";

test("headers round-trip long paths and sizes beyond the octal limit", () => {
  const long = `db/${"a".repeat(90)}/${"b".repeat(90)}`;
  for (const member of [
    { path: "db", type: "directory" as const, size: 0 },
    { path: long, type: "file" as const, size: 3 },
    { path: "checkpoints/large.tar", type: "file" as const, size: 9 * 1024 ** 3 },
  ])
    expect(parseTarHeader(tarHeader(member))).toEqual(member);
  expect(parseTarHeader(new Uint8Array(BLOCK))).toBeNull();
});

test("the reader refuses links and edited headers", () => {
  const link = tarHeader({ path: "db/file", type: "file", size: 0 });
  link[156] = "2".charCodeAt(0);
  expect(() => parseTarHeader(link)).toThrow("header");
  const edited = tarHeader({ path: "db/file", type: "file", size: 0 });
  edited[0] = "x".charCodeAt(0);
  expect(() => parseTarHeader(edited)).toThrow("header");
});

test("system tar reads the archive members", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc-backup-tar-"));
  try {
    const content = Buffer.from("hello");
    const archive = Buffer.concat([
      tarHeader({ path: "keys", type: "directory", size: 0 }),
      tarHeader({ path: "keys/name", type: "file", size: content.length }),
      content,
      Buffer.alloc(tarPadding(content.length)),
      Buffer.alloc(BLOCK * 2),
    ]);
    await writeFile(join(directory, "a.tar"), archive);
    const extracted = Bun.spawnSync(["tar", "-xf", "a.tar"], { cwd: directory });
    expect(extracted.exitCode).toBe(0);
    expect(await readFile(join(directory, "keys/name"), "utf8")).toBe("hello");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
