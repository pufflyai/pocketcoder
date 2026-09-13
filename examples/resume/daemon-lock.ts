import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

export function daemonLock(directory: string) {
  return join(directory, "daemon.lock");
}

export async function claimDaemon(directory: string) {
  const path = daemonLock(directory);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
  return { release: () => rm(path, { recursive: true }) };
}
