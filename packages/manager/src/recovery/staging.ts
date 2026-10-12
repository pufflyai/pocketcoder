import { existsSync, lstatSync, realpathSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { lockDataFolder } from "@pstdio/pocketcoder-db/engine";
import {
  checkStagingCapacity,
  readPrivateFile,
  requireOutsideDataFolder,
  type StagingPolicy,
  stagingDisk,
} from "@pstdio/pocketcoder-db/off-node";
import type { PurgeAuthorityConfig } from "../purge/authority";

export interface ManagerBackupOptions {
  dataDir: string;
  purge: PurgeAuthorityConfig;
  encryptionKeyFile: string;
  operationId: string;
  staging?: StagingPolicy;
}
export async function managerEncryptionKey(options: ManagerBackupOptions) {
  await requireOutsideDataFolder(options.dataDir, options.encryptionKeyFile);
  await requireOutsideDataFolder(options.purge.directory, options.encryptionKeyFile);
  const key = await readPrivateFile(options.encryptionKeyFile, 32);
  if (key.length !== 32) throw new Error("Manager backups require a separate 32-byte encryption key.");
  return key;
}
export async function managerStaging(options: ManagerBackupOptions) {
  const root = join(realpathSync(options.purge.directory), "manager-backups");
  await mkdir(root, { mode: 0o700, recursive: true });
  const info = lstatSync(root);
  if (!info.isDirectory() || (info.mode & 0o777) !== 0o700 || realpathSync(root) !== root)
    throw new Error("Manager backup staging must be private and direct.");
  const directory = join(root, options.operationId);
  const folder = lockDataFolder(directory);
  const disk = await stagingDisk(directory, options.staging);
  return {
    directory,
    async maximum() {
      const current = await stagingDisk(directory, options.staging);
      return Math.min(current.maximum.bytes, current.bytes - 64 * 1024 ** 2);
    },
    async admit(amount: { bytes: number; files: number }) {
      checkStagingCapacity(amount, await stagingDisk(directory, options.staging));
    },
    policy(amount: { bytes: number; files: number }) {
      if (amount.bytes > disk.maximum.bytes || amount.files > disk.maximum.files)
        throw new Error("Manager staging exceeds its configured operation limit.");
    },
    async reset() {
      folder.validate();
      for (const name of ["plain.tar", ".plain.tar.partial", "encrypted", "verified"]) {
        const path = join(directory, name);
        if (existsSync(path)) await rm(path, { recursive: true });
      }
      folder.validate();
    },
    close: () => folder.close(),
  };
}
