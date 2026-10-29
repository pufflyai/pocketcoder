import { expect, test } from "bun:test";
import { lstatSync, writeFileSync } from "node:fs";
import { link, mkdir, mkdtemp, realpath, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertCheckpointCustody, checkpointCustody } from "./source-custody";

async function fixture(run: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "checkpoint-custody-")));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("native file and directory identities round trip through 64 private bytes", async () => {
  await fixture(async (root) => {
    writeFileSync(join(root, "file"), "real native content", { mode: 0o640 });
    await mkdir(join(root, "directory"), { mode: 0o750 });
    for (const name of ["file", "directory"]) {
      const stat = lstatSync(join(root, name), { bigint: true });
      const encoded = checkpointCustody(stat);
      expect(encoded.length).toBe(64);
      expect(encoded.readBigUInt64BE(0)).toBe(stat.dev);
      expect(encoded.readBigUInt64BE(8)).toBe(stat.ino);
      expect(encoded.readBigUInt64BE(24)).toBe(stat.mtimeNs);
      expect(encoded.readUInt32BE(48)).toBe(Number(stat.mode));
      expect(() => assertCheckpointCustody(lstatSync(join(root, name), { bigint: true }), encoded)).not.toThrow();
    }
    expect(() => assertCheckpointCustody(lstatSync(join(root, "file"), { bigint: true }), Buffer.alloc(63))).toThrow();
  });
});

test("a same-inode rewrite cannot regain custody by restoring the old modification time", async () => {
  await fixture(async (root) => {
    const path = join(root, "file");
    writeFileSync(path, "before");
    const original = lstatSync(path, { bigint: true });
    const encoded = checkpointCustody(original);
    await Bun.sleep(2);
    writeFileSync(path, "after!");
    await utimes(path, original.atime, original.mtime);
    const changed = lstatSync(path, { bigint: true });
    expect(changed.ino).toBe(original.ino);
    expect(changed.size).toBe(original.size);
    expect(() => assertCheckpointCustody(changed, encoded)).toThrow("changed");
  });
});

test("native inode replacement and link count changes refuse the captured identity", async () => {
  await fixture(async (root) => {
    const path = join(root, "file");
    writeFileSync(path, "payload");
    const encoded = checkpointCustody(lstatSync(path, { bigint: true }));
    await link(path, join(root, "hardlink"));
    expect(() => assertCheckpointCustody(lstatSync(path, { bigint: true }), encoded)).toThrow("changed");
    writeFileSync(join(root, "replacement"), "payload");
    expect(() => assertCheckpointCustody(lstatSync(join(root, "replacement"), { bigint: true }), encoded)).toThrow(
      "changed",
    );
  });
});
