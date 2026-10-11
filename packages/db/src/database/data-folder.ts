import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalPathCheck } from "./canonical-path";
import { openDataDirectory } from "./directory-identity";
import { assertActiveDirectory } from "./retired-directory";
import { lockWriterDescriptor } from "./writer-lock";

export function lockDataFolder(directory: string) {
  const requested = resolve(directory);
  mkdirSync(requested, { recursive: true, mode: 0o700 });
  const dir = realpathSync(requested);
  // The held directory already checks canonical requests on every validation.
  const isOriginalPath = requested === dir ? undefined : canonicalPathCheck(requested, dir);
  assertActiveDirectory(dir);
  const descriptor = openSync(join(dir, "LOCK"), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    lockWriterDescriptor(descriptor, dir);
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
  let closed = false;
  let identity: ReturnType<typeof openDataDirectory> | undefined;
  let rootIdentity: Stats;
  function validateLockAt(path: string) {
    if (closed) throw new Error("Data writer lock is closed.");
    const current = lstatSync(join(path, "LOCK"));
    const owned = fstatSync(descriptor);
    if (
      !owned.isFile() ||
      !current.isFile() ||
      current.dev !== owned.dev ||
      current.ino !== owned.ino ||
      owned.nlink !== 1
    )
      throw new Error("Data writer lock was replaced.");
  }
  function validateAt(path: string) {
    const root = lstatSync(path);
    if (
      !root.isDirectory() ||
      root.dev !== rootIdentity.dev ||
      root.ino !== rootIdentity.ino ||
      realpathSync(path) !== path
    )
      throw new Error("Data directory was replaced or redirected.");
    if ((root.mode & 0o777) !== 0o700) throw new Error("Data directory must have mode 0700.");
    validateLockAt(path);
  }
  try {
    rootIdentity = lstatSync(dir);
    validateLockAt(dir);
    assertActiveDirectory(dir);
    fchmodSync(descriptor, 0o600);
    const root = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fchmodSync(root, 0o700);
      fsyncSync(root);
    } finally {
      closeSync(root);
    }
    identity = openDataDirectory(dir);
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
  function validate() {
    identity?.validate();
    validateLockAt(dir);
    assertActiveDirectory(dir);
    if (isOriginalPath && !isOriginalPath()) throw new Error("Data directory was redirected.");
  }
  return {
    dir,
    validateAt,
    validate,
    sourceWriter() {
      validate();
      const root = lstatSync(dir, { bigint: true });
      const lock = fstatSync(descriptor, { bigint: true });
      return {
        format: "pocketcoder-source-writer/v1" as const,
        directory: dir,
        root: { device: root.dev.toString(), inode: root.ino.toString() },
        lock: { device: lock.dev.toString(), inode: lock.ino.toString() },
      };
    },
    close() {
      if (closed) return;
      closed = true;
      // Closing the descriptor also releases the kernel lock after SIGKILL.
      try {
        identity?.close();
      } finally {
        closeSync(descriptor);
      }
    },
  };
}

export function syncDirectory(directory: string) {
  const descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

type SeedEntry = { path: string; directory: boolean };

function seedEntries(directory: string): SeedEntry[] {
  return [
    { path: directory, directory: true },
    ...readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? seedEntries(path) : [{ path, directory: false }];
    }),
  ];
}

function openSeedEntry(entry: SeedEntry) {
  return open(entry.path, constants.O_RDONLY | (entry.directory ? constants.O_DIRECTORY : constants.O_NOFOLLOW));
}

async function prepareSeedEntry(entry: SeedEntry) {
  const handle = await openSeedEntry(entry);
  try {
    await handle.chmod(entry.directory ? 0o700 : 0o600);
  } finally {
    await handle.close();
  }
}

async function syncSeedEntry(entry: SeedEntry) {
  const handle = await openSeedEntry(entry);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Overlapping per-entry syncs lets files share a journal commit.
const SEED_SYNC_WIDTH = 32;

async function seedPass(entries: SeedEntry[], action: (entry: SeedEntry) => Promise<void>) {
  let next = 0;
  async function syncNext() {
    for (let entry = entries[next++]; entry; entry = entries[next++]) {
      try {
        await action(entry);
      } catch (error) {
        next = entries.length;
        throw error;
      }
    }
  }
  // The caller releases the folder lock when this fails, so every worker stops first.
  const results = await Promise.allSettled(Array.from({ length: SEED_SYNC_WIDTH }, syncNext));
  for (const result of results) if (result.status === "rejected") throw result.reason;
}

export async function syncSeed(directory: string) {
  const entries = seedEntries(directory);
  // Finish private modes before syncing. Later chmods otherwise dirty more inode
  // metadata while earlier workers are waiting for journal commits.
  await seedPass(entries, prepareSeedEntry);
  await seedPass(entries, syncSeedEntry);
}
