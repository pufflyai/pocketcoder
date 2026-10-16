import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface ProjectionCapacity {
  bytes: number;
  files: number;
}

async function usage(path: string): Promise<ProjectionCapacity> {
  const total = { bytes: 0, files: 0 };
  let entries: string[];
  try {
    entries = await readdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return total;
    throw error;
  }
  for (const name of entries) {
    const child = join(path, name);
    const stat = await lstat(child);
    if (stat.isDirectory()) {
      const nested = await usage(child);
      total.bytes += nested.bytes;
      total.files += nested.files;
    } else if (stat.isFile() && stat.nlink === 1) {
      total.bytes += stat.size;
      total.files++;
    } else {
      throw new Error("Invalid input projection storage entry.");
    }
  }
  return total;
}

export async function requireProjectionCapacity(roots: string[], added: ProjectionCapacity, limit: ProjectionCapacity) {
  const total = { ...added };
  for (const root of roots) {
    const current = await usage(root);
    total.bytes += current.bytes;
    total.files += current.files;
  }
  if (total.bytes > limit.bytes || total.files > limit.files)
    throw new Error("Input projection capacity is exhausted.");
}
