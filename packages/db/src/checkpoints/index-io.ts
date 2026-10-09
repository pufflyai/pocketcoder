import { fstatSync, readSync, writeSync } from "node:fs";
import type { createBackupFile } from "../database/backup-native-file";

export type IndexFile = ReturnType<typeof createBackupFile>;

export function writeIndexBytes(file: IndexFile, bytes: Buffer, position: number, wrote?: (size: number) => void) {
  let offset = 0;
  while (offset < bytes.length) {
    file.validate();
    const written = writeSync(file.descriptor, bytes, offset, bytes.length - offset, position + offset);
    wrote?.(written);
    file.validate();
    if (!written) throw new Error("Checkpoint index write made no progress.");
    offset += written;
  }
}

export function readIndexBytes(file: IndexFile, size: number, position: number) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    file.validate();
    const read = readSync(file.descriptor, bytes, offset, size - offset, position + offset);
    file.validate();
    if (!read) throw new Error("Checkpoint index is truncated.");
    offset += read;
  }
  return bytes;
}

export function physicalIndexBytes(file: IndexFile) {
  return fstatSync(file.descriptor).size;
}
