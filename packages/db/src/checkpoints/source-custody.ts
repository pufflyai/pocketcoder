import type { BigIntStats } from "node:fs";

const wide = ["dev", "ino", "size", "mtimeNs", "ctimeNs", "nlink"] as const;
const narrow = ["mode", "uid", "gid"] as const;

export function checkpointCustody(stat: BigIntStats) {
  const bytes = Buffer.alloc(64);
  for (const [index, key] of wide.entries()) bytes.writeBigUInt64BE(stat[key], index * 8);
  for (const [index, key] of narrow.entries()) bytes.writeUInt32BE(Number(stat[key]), 48 + index * 4);
  bytes.writeUInt32BE(1, 60);
  return bytes;
}

export function assertCheckpointCustody(stat: BigIntStats, expected: Buffer) {
  if (expected.length !== 64 || !checkpointCustody(stat).equals(expected))
    throw new Error("Checkpoint source custody changed.");
}
