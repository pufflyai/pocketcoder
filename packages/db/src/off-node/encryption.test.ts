import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptFile, encryptFile, open, seal } from "./encryption";

test("outer encryption keeps keys external and rejects swapped or altered objects", () => {
  const key = randomBytes(32);
  const plain = Buffer.from("independent deletion journal");
  const encrypted = seal(plain, key, "account-a/journal");
  expect(encrypted.includes(plain)).toBe(false);
  expect(open(encrypted, key, "account-a/journal")).toEqual(plain);
  expect(() => open(encrypted, key, "account-b/journal")).toThrow();
  expect(() => open(encrypted, randomBytes(32), "account-a/journal")).toThrow();
  encrypted[encrypted.length - 1] = (encrypted[encrypted.length - 1] as number) ^ 1;
  expect(() => open(encrypted, key, "account-a/journal")).toThrow();
});

test("streamed backup encryption verifies complete bytes before publishing a restored archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc93-encryption-"));
  try {
    const source = join(root, "source.tar");
    const encrypted = join(root, "backup.enc");
    const restored = join(root, "restored.tar");
    const bytes = randomBytes(8 * 1024 ** 2);
    const key = randomBytes(32);
    await writeFile(source, bytes);
    await encryptFile(source, encrypted, key, "account-a/backup");
    await expect(decryptFile(encrypted, restored, randomBytes(32), "account-a/backup")).rejects.toThrow();
    expect(await Bun.file(restored).exists()).toBe(false);
    await decryptFile(encrypted, restored, key, "account-a/backup");
    expect(await readFile(restored)).toEqual(bytes);
    await expect(decryptFile(encrypted, restored, key, "account-a/backup")).rejects.toThrow();
    expect(await readFile(restored)).toEqual(bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
