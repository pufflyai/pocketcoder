import { chmod, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

async function unlockDirectories(path: string) {
  await chmod(path, 0o700);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) await unlockDirectories(join(path, entry.name));
  }
}

export async function removeRunDirectory(path: string) {
  // Checkpoint directories are read-only. Only unlock this run's own tree,
  // and never follow a workspace-created symlink outside it.
  await unlockDirectories(path);
  await rm(path, { recursive: true, force: true });
}
