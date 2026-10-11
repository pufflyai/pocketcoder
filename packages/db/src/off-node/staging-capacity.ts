import { lstat, readdir, statfs } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { BackupManifest } from "../backup/manifest";

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const StagingPolicySchema = z.strictObject({
  maxBytes: integer.positive().optional(),
  maxFiles: integer.positive().optional(),
});
export type StagingPolicy = z.infer<typeof StagingPolicySchema>;
export const StagingFootprintSchema = z.strictObject({ bytes: integer, files: integer, directories: integer });
export type StagingFootprint = z.infer<typeof StagingFootprintSchema>;
export const STAGING_HEADROOM = { bytes: 64 * 1024 ** 2, files: 16 };
// Opening a physical database writes recovery/WAL files before it can be checked again.
export const DATABASE_WORK = { bytes: 64 * 1024 ** 2, files: 16 };

export function manifestFootprint(manifest: BackupManifest, databaseOnly = false) {
  const result = { bytes: 0, files: 0, directories: 0 };
  for (const member of manifest.members) {
    if (databaseOnly && member.path !== "db" && !member.path.startsWith("db/")) continue;
    if (member.type === "directory") result.directories++;
    else {
      result.bytes += member.bytes;
      result.files++;
    }
  }
  return StagingFootprintSchema.parse(result);
}

export async function sourceFootprint(directory: string): Promise<StagingFootprint> {
  const result = { bytes: 0, files: 0, directories: 1 };
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const info = await lstat(path);
    if (info.isDirectory()) {
      const child = await sourceFootprint(path);
      result.bytes += child.bytes;
      result.files += child.files;
      result.directories += child.directories;
    } else if (info.isFile()) {
      result.bytes += info.size;
      result.files++;
    } else throw new Error("Backup source has a nonregular entry.");
  }
  return StagingFootprintSchema.parse(result);
}

export function allocated(footprint: StagingFootprint, block: number) {
  return {
    bytes: footprint.bytes + footprint.files * (2 * block - 1) + footprint.directories * 2 * block,
    files: footprint.files + footprint.directories,
  };
}

export function copies(
  archiveBytes: number,
  footprint: StagingFootprint,
  database: StagingFootprint,
  block: number,
  restore: boolean,
) {
  const extracted = restore ? allocated(footprint, block) : { bytes: 0, files: 0 };
  const verification = allocated(database, block);
  // Capture may hold plaintext, ciphertext and retry .check together. Restore holds two archives.
  const archives = (restore ? 2 : 3) * (archiveBytes + 2 * block) + 41;
  return {
    bytes: archives + extracted.bytes + verification.bytes + DATABASE_WORK.bytes * (restore ? 2 : 1),
    files: (restore ? 2 : 3) + extracted.files + verification.files + DATABASE_WORK.files * (restore ? 2 : 1) + 16,
  };
}

export async function stagingDisk(directory: string, policy: StagingPolicy = {}) {
  StagingPolicySchema.parse(policy);
  const disk = await statfs(directory);
  return {
    block: disk.bsize,
    bytes: Math.min(Number.MAX_SAFE_INTEGER, disk.bavail * disk.bsize),
    files: Math.min(Number.MAX_SAFE_INTEGER, disk.ffree),
    maximum: { bytes: policy.maxBytes ?? Number.MAX_SAFE_INTEGER, files: policy.maxFiles ?? Number.MAX_SAFE_INTEGER },
  };
}

export function checkStagingCapacity(
  amount: { bytes: number; files: number },
  disk: Awaited<ReturnType<typeof stagingDisk>>,
  outstanding = { bytes: 0, files: 0 },
) {
  if (
    ![amount.bytes, amount.files].every(Number.isSafeInteger) ||
    amount.bytes > disk.maximum.bytes ||
    amount.files > disk.maximum.files ||
    amount.bytes > disk.bytes - STAGING_HEADROOM.bytes - outstanding.bytes ||
    amount.files > disk.files - STAGING_HEADROOM.files - outstanding.files
  )
    throw new Error("Off-node staging capacity is exhausted.");
}

export async function materialized(paths: string[]) {
  const result = { bytes: 0, files: 0 };
  async function visit(path: string) {
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    result.bytes += info.blocks * 512;
    result.files++;
    if (info.isDirectory()) for (const name of await readdir(path)) await visit(join(path, name));
    else if (!info.isFile()) throw new Error("Off-node staging entry is not regular.");
  }
  for (const path of paths) await visit(path);
  return result;
}
