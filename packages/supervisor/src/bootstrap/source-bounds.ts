import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

export async function verifySourceBounds(root: string, maxBytes: number, maxFiles: number) {
  let bytes = 0;
  let files = 0;
  async function visit(directory: string) {
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const stat = await lstat(path);
      files += 1;
      if (files > maxFiles) throw new Error("Source exceeds its entry limit.");
      if (stat.isDirectory()) await visit(path);
      else {
        bytes += stat.size;
        if (bytes > maxBytes) throw new Error("Source exceeds its byte limit.");
      }
    }
  }
  await visit(root);
}
