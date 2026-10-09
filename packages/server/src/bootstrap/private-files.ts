import { closeSync, constants, fsyncSync, openSync } from "node:fs";

export function syncPrivateDirectory(directory: string) {
  const descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
