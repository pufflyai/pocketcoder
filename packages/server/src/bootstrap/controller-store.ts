import { randomBytes } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { type DatabaseOpenOptions, PGliteStore } from "@pstdio/pocketcoder-db";
import { syncPrivateDirectory } from "./private-files";

const keyNames = ["auth-pepper", "event-signing-key", "secret-key"] as const;

async function readPrivateKey(path: string, unpublished = false) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size > 32) {
      throw new Error(`controller key must be a private 32-byte file: ${path}`);
    }
    if (info.size < 32) {
      // A partial staging write has never supplied a database signing identity.
      if (unpublished) return null;
      throw new Error(`controller key must be a private 32-byte file: ${path}`);
    }
    return await file.readFile();
  } finally {
    await file.close();
  }
}

async function requirePrivateDirectory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || (info.mode & 0o777) !== 0o700) {
    throw new Error(`controller key directory must have mode 0700: ${path}`);
  }
}

async function initializeKeys(directory: string) {
  const destination = join(directory, "keys");
  if (!existsSync(destination)) {
    if (existsSync(join(directory, "db"))) {
      throw new Error("initialized data folder has no key bundle; restore or import its original keys");
    }
    const stage = join(directory, ".keys-staging");
    await mkdir(stage, { recursive: true, mode: 0o700 });
    await requirePrivateDirectory(stage);
    for (const name of keyNames) {
      const path = join(stage, name);
      if (existsSync(path)) {
        if (await readPrivateKey(path, true)) continue;
      }
      const temporary = `${path}.tmp`;
      await rm(temporary, { force: true });
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try {
        await file.writeFile(randomBytes(32));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
      syncPrivateDirectory(stage);
    }
    syncPrivateDirectory(stage);
    await rename(stage, destination);
    syncPrivateDirectory(directory);
  }
  await requirePrivateDirectory(destination);
  const [pepper, eventSigningKey, secretKey] = await Promise.all(
    keyNames.map((name) => readPrivateKey(join(destination, name))),
  );
  if (!pepper || !eventSigningKey || !secretKey) throw new Error("incomplete controller key bundle");
  return {
    pepper: pepper.toString("base64url"),
    eventSigningKey: eventSigningKey.toString("base64url"),
    secretKey: secretKey.toString("base64url"),
  };
}

export async function openControllerStore(dataDir: string, journalDir?: string) {
  let keys: Awaited<ReturnType<typeof initializeKeys>> | undefined;
  const options: DatabaseOpenOptions = {
    ...(journalDir ? { journalDir } : {}),
    async beforeOpen(directory) {
      keys = await initializeKeys(directory);
    },
  };
  const store = await PGliteStore.create(dataDir, options);
  if (!keys) {
    await store.close();
    throw new Error("controller store requires a disk data folder");
  }
  return { store, keys, dataDirectory: await realpath(dataDir) };
}
