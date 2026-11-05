import type { Stats } from "node:fs";
import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { join } from "node:path";
import type { ExportExtraction } from "@pstdio/pocketcoder-runtime-core";

// Called only after provider stop proof. No workload code or writable aliases may
// remain while the trusted storage owner walks this allocation.
export async function readExportFiles(
  root: string,
  mounts: string[],
  limits: { bytes: number; files: number },
  signal: AbortSignal,
): Promise<ExportExtraction> {
  signal.throwIfAborted();
  if (mounts.some((name) => !/^[a-z0-9][a-z0-9-]*$/.test(name))) throw new Error("Invalid export mount");
  const files: ExportExtraction["files"] = [];
  const errors = new Set<string>();
  let bytes = 0;
  const allocation = await lstat(root).catch(() => null);
  if (!allocation?.isDirectory() || allocation.isSymbolicLink()) return { files, errors: ["storage_unavailable"] };
  const device = allocation.dev;

  async function walk(path: string, name: string) {
    signal.throwIfAborted();
    const stat = await lstat(path).catch(() => null);
    if (!stat) {
      errors.add("storage_unavailable");
      return;
    }
    if (stat.isSymbolicLink() || stat.dev !== device) {
      errors.add("unsafe_file");
      return;
    }
    if (stat.isDirectory()) {
      for await (const child of await opendir(path)) await walk(join(path, child.name), `${name}/${child.name}`);
      return;
    }
    if (!stat.isFile() || stat.nlink !== 1) {
      errors.add("unsafe_file");
      return;
    }
    if (files.length >= limits.files || stat.size > limits.bytes - bytes) {
      errors.add("export_limit");
      return;
    }
    const content = await readRegularFile(path, stat, signal);
    files.push({ name, bytes: content });
    bytes += content.length;
  }
  for (const mount of mounts) await walk(join(root, mount), mount);
  return { files, errors: [...errors] };
}

async function readRegularFile(path: string, stat: Stats, signal: AbortSignal) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.nlink !== 1) {
      throw new Error("Export inode changed after writer stop");
    }
    const content = new Uint8Array(stat.size);
    let offset = 0;
    while (offset < content.length) {
      signal.throwIfAborted();
      const read = await handle.read(content, offset, Math.min(64 * 1024, content.length - offset), offset);
      if (!read.bytesRead) throw new Error("Export changed after writer stop");
      offset += read.bytesRead;
    }
    signal.throwIfAborted();
    return content;
  } finally {
    await handle.close();
  }
}
