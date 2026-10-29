import { fstatSync } from "node:fs";
import { type CheckpointArchiveEntry, canonicalJson } from "@pstdio/pocketcoder-contracts";
import { createBackupFile } from "../database/backup-native-file";
import { destinationTimestamp } from "./destination-metadata";
import type { DestinationStat } from "./destination-stat";
import { createCheckpointEntryIndex } from "./entry-index";
import { readIndexBytes, writeIndexBytes } from "./index-io";

export interface DestinationIndex {
  count: number;
  ordinal(mount: number, path: string): Promise<number | null>;
  entryAt(ordinal: number): Promise<CheckpointArchiveEntry>;
}
const wide = ["dev", "ino", "size", "mtimeNs", "ctimeNs", "nlink"] as const;
const narrow = ["mode", "uid", "gid"] as const;
export function destinationCustody(stat: DestinationStat) {
  const bytes = Buffer.alloc(64);
  for (const [index, key] of wide.entries()) bytes.writeBigInt64BE(BigInt.asIntN(64, stat[key]), index * 8);
  for (const [index, key] of narrow.entries()) bytes.writeUInt32BE(Number(stat[key]), 48 + index * 4);
  bytes.writeUInt32BE(1, 60);
  return bytes;
}
export function assertDestinationCustody(stat: DestinationStat, expected: Buffer) {
  if (!destinationCustody(stat).equals(expected)) throw new Error("Checkpoint destination custody changed.");
}
export function assertDestinationIdentity(stat: DestinationStat, expected: Buffer) {
  const actual = destinationCustody(stat);
  if (
    !actual.subarray(0, 16).equals(expected.subarray(0, 16)) ||
    !actual.subarray(52, 60).equals(expected.subarray(52, 60))
  )
    throw new Error("Checkpoint destination identity changed.");
}
export async function createDestinationCustody(
  directory: string,
  source: DestinationIndex,
  maxBytes: number,
  check: () => void,
) {
  const slotBytes = source.count * 80;
  if (!Number.isSafeInteger(slotBytes) || !Number.isSafeInteger(maxBytes) || maxBytes < slotBytes)
    throw new Error("Checkpoint destination custody exceeds its reservation.");
  const index = createCheckpointEntryIndex(directory, { maxBytes: maxBytes - slotBytes, check });
  let slots: ReturnType<typeof createBackupFile> | undefined;
  try {
    for (let ordinal = 0; ordinal < source.count; ordinal++) {
      const entry = await source.entryAt(ordinal);
      destinationTimestamp(entry.mtime_ns);
      await index.append(entry);
    }
    const complete = index.seal();
    slots = createBackupFile(directory, check);
    const file = slots;
    // Reserve physical slot space before any destination tree is created.
    if (slotBytes) writeIndexBytes(file, Buffer.alloc(80), slotBytes - 80);
    function read(ordinal: number) {
      if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= source.count)
        throw new Error("Invalid destination ordinal.");
      return readIndexBytes(file, 80, ordinal * 80);
    }
    return {
      ...complete,
      bytes: () => index.bytes + Number(fstatSync(file.descriptor, { bigint: true }).size),
      async locate(entry: CheckpointArchiveEntry) {
        const ordinal = await complete.ordinal(entry.mount, entry.path);
        if (ordinal === null || canonicalJson(await complete.entryAt(ordinal)) !== canonicalJson(entry))
          throw new Error("Checkpoint destination entry is not admitted.");
        return ordinal;
      },
      read,
      retain(ordinal: number, stat: DestinationStat, state: number) {
        const bytes = Buffer.alloc(80);
        bytes[0] = state;
        destinationCustody(stat).copy(bytes, 8);
        writeIndexBytes(file, bytes, ordinal * 80);
      },
      validate: () => {
        complete.validate();
        file.validate();
      },
      async close() {
        const results = await Promise.allSettled([index.close(), file.close()]);
        for (const result of results) if (result.status === "rejected") throw result.reason;
      },
    };
  } catch (error) {
    await Promise.allSettled([index.close(), slots?.close()]);
    throw error;
  }
}
