import { compareCheckpointPaths, readCheckpointIndexEntry } from "./entry-record";
import { type IndexFile, readIndexBytes, writeIndexBytes } from "./index-io";

interface MergeOptions {
  records: IndexFile;
  recordBytes: number;
  source: IndexFile;
  target: IndexFile;
  count: number;
  width: number;
  boundary(): Promise<void>;
  wrote(bytes: number): void;
}

function takeLeft(first: { entry: CheckpointArchiveEntry } | null, second: { entry: CheckpointArchiveEntry } | null) {
  if (!first) return false;
  if (!second) return true;
  const comparison = compareCheckpointPaths(first.entry, second.entry);
  if (!comparison) throw new Error("Checkpoint sort contains a duplicate mount and path.");
  return comparison < 0;
}

export async function mergeCheckpointOffsets(options: MergeOptions) {
  const { records, recordBytes, source, target, count, width } = options;
  async function head(index: number, end: number) {
    if (index === end) return null;
    await options.boundary();
    const offset = readIndexBytes(source, 8, index * 8);
    return { offset, entry: readCheckpointIndexEntry(records, recordBytes, Number(offset.readBigUInt64BE())) };
  }
  let written = 0;
  for (let start = 0; start < count; start += width * 2) {
    let left = start;
    const leftEnd = Math.min(start + width, count);
    let right = leftEnd;
    const rightEnd = Math.min(start + width * 2, count);
    let first = await head(left, leftEnd);
    let second = await head(right, rightEnd);
    while (first || second) {
      const takeFirst = takeLeft(first, second);
      await options.boundary();
      let entryBytes = 0;
      const wrote = (size: number) => {
        entryBytes += size;
        options.wrote(written * 8 + entryBytes);
      };
      if (takeFirst && first) {
        writeIndexBytes(target, first.offset, written * 8, wrote);
      } else if (second) {
        writeIndexBytes(target, second.offset, written * 8, wrote);
      }
      written++;
      if (takeFirst) first = await head(++left, leftEnd);
      else second = await head(++right, rightEnd);
    }
  }
}

import type { CheckpointArchiveEntry } from "@pstdio/pocketcoder-contracts";
