import { closeSync, constants, fstatSync } from "node:fs";
import type { CheckpointStageIdentity } from "@pstdio/pocketcoder-runtime-contracts";
import { destinationOpen } from "../checkpoints/destination-native";
import { openDataDirectory } from "../database/directory-identity";
import { fileChunks } from "./file-chunks";

// Holds a published checkpoint archive open by descriptor. A later deletion only removes
// its name, so the backup still copies the exact bytes its database snapshot references.
export function openPublishedArchive(directory: string, name: string, identity: CheckpointStageIdentity) {
  const folder = openDataDirectory(directory);
  let file: number;
  try {
    file = destinationOpen(folder.descriptor, name, constants.O_RDONLY);
  } finally {
    folder.close();
  }
  const size = Number(identity.size);
  function validate() {
    const stat = fstatSync(file, { bigint: true });
    if (
      !stat.isFile() ||
      String(stat.dev) !== identity.device ||
      String(stat.ino) !== identity.inode ||
      String(stat.size) !== identity.size ||
      String(stat.mtimeNs) !== identity.mtimeNs
    )
      throw new Error(`Checkpoint archive differs from its publication: ${name}`);
  }
  try {
    validate();
  } catch (error) {
    closeSync(file);
    throw error;
  }
  return {
    name,
    size,
    chunks: (check: () => void) =>
      fileChunks(file, size, () => {
        check();
        validate();
      }),
    close: () => closeSync(file),
  };
}
export type PublishedArchive = ReturnType<typeof openPublishedArchive>;
