import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGliteStore } from "@pstdio/pocketcoder-db";
import { openControllerStore } from "./controller-store";

test("first start publishes private independent keys and restart reuses them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc-controller-keys-"));
  try {
    const first = await openControllerStore(directory);
    const keys = first.keys;
    expect(new Set(Object.values(keys)).size).toBe(3);
    for (const name of ["auth-pepper", "event-signing-key", "secret-key"]) {
      expect((await readFile(join(directory, "keys", name))).length).toBe(32);
      expect((await stat(join(directory, "keys", name))).mode & 0o777).toBe(0o600);
    }
    expect((await stat(join(directory, "keys"))).mode & 0o777).toBe(0o700);
    await expect(openControllerStore(directory)).rejects.toThrow("data folder is in use");
    await first.store.close();
    const second = await openControllerStore(directory);
    try {
      expect(second.keys).toEqual(keys);
    } finally {
      await second.store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("interrupted first-start key staging preserves already written keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc-controller-interrupted-"));
  try {
    const staged = join(directory, ".keys-staging");
    await mkdir(staged, { mode: 0o700 });
    const pepper = Buffer.alloc(32, 7);
    await writeFile(join(staged, "auth-pepper"), pepper, { mode: 0o600 });
    const opened = await openControllerStore(directory);
    try {
      expect(opened.keys.pepper).toBe(pepper.toString("base64url"));
      expect(await Bun.file(join(directory, ".keys-staging", "auth-pepper")).exists()).toBe(false);
    } finally {
      await opened.store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an interrupted unpublished key write is repaired without changing completed keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc-controller-partial-key-"));
  try {
    const staged = join(directory, ".keys-staging");
    await mkdir(staged, { mode: 0o700 });
    await writeFile(join(staged, "auth-pepper"), Buffer.alloc(0), { mode: 0o600 });
    const eventKey = Buffer.alloc(32, 19);
    await writeFile(join(staged, "event-signing-key"), eventKey, { mode: 0o600 });
    const opened = await openControllerStore(directory);
    try {
      expect(opened.keys.eventSigningKey).toBe(eventKey.toString("base64url"));
      expect((await readFile(join(directory, "keys", "auth-pepper"))).length).toBe(32);
    } finally {
      await opened.store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an initialized database with missing keys is never given new signing identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc-controller-missing-keys-"));
  try {
    const store = await PGliteStore.create(directory);
    await store.close();
    await expect(openControllerStore(directory)).rejects.toThrow("initialized data folder has no key bundle");
    expect(await Bun.file(join(directory, "keys", "auth-pepper")).exists()).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("an incomplete published bundle fails without replacing any key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc-controller-incomplete-keys-"));
  try {
    await mkdir(join(directory, "keys"), { mode: 0o700 });
    const pepper = Buffer.alloc(32, 9);
    await writeFile(join(directory, "keys", "auth-pepper"), pepper, { mode: 0o600 });
    await expect(openControllerStore(directory)).rejects.toThrow();
    expect(await readFile(join(directory, "keys", "auth-pepper"))).toEqual(pepper);
    expect(await Bun.file(join(directory, "keys", "event-signing-key")).exists()).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
