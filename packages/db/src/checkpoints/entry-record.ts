import {
  CHECKPOINT_ENTRY_BYTES,
  type CheckpointArchiveEntry,
  CheckpointArchiveEntrySchema,
  canonicalJson,
  checkpointDocument,
} from "@pstdio/pocketcoder-contracts";
import { type IndexFile, readIndexBytes, writeIndexBytes } from "./index-io";

export function compareCheckpointPaths(left: { mount: number; path: string }, right: { mount: number; path: string }) {
  return left.mount - right.mount || Buffer.compare(Buffer.from(left.path), Buffer.from(right.path));
}

function readEntryRecord(records: IndexFile, bytes: number, offset: number) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 4 > bytes)
    throw new Error("Invalid checkpoint index offset.");
  const framed = readIndexBytes(records, 4, offset).readUInt32BE();
  const length = framed & 0x7fff_ffff;
  const custodySize = framed >= 0x8000_0000 ? 64 : 0;
  if (length > CHECKPOINT_ENTRY_BYTES || offset + 4 + length + custodySize > bytes)
    throw new Error("Invalid checkpoint index record size.");
  const entry = checkpointDocument(readIndexBytes(records, length, offset + 4), CheckpointArchiveEntrySchema, "index");
  return { entry, custodyOffset: custodySize ? offset + 4 + length : null };
}

export function readCheckpointIndexEntry(records: IndexFile, bytes: number, offset: number) {
  return readEntryRecord(records, bytes, offset).entry;
}

export function readCheckpointSourceRecord(records: IndexFile, bytes: number, offset: number) {
  const record = readEntryRecord(records, bytes, offset);
  const custody = record.custodyOffset === null ? undefined : readIndexBytes(records, 64, record.custodyOffset);
  return { entry: record.entry, custody };
}

export function checkpointSortRecord(value: CheckpointArchiveEntry, custody?: Buffer) {
  if (custody && custody.length !== 64) throw new Error("Invalid checkpoint source custody size.");
  const privateBytes = custody && Buffer.from(custody);
  const entry = CheckpointArchiveEntrySchema.parse(value);
  const document = Buffer.from(canonicalJson(entry));
  if (document.length > CHECKPOINT_ENTRY_BYTES) throw new Error("Checkpoint sort record is too large.");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(document.length + (privateBytes ? 0x8000_0000 : 0));
  return { document, privateBytes, length, size: 4 + document.length + (privateBytes?.length ?? 0) };
}

export function writeCheckpointSortRecord(
  records: IndexFile,
  order: IndexFile,
  position: number,
  index: number,
  record: ReturnType<typeof checkpointSortRecord>,
  wrote: { records(size: number): void; offsets(size: number): void },
) {
  const offset = Buffer.alloc(8);
  offset.writeBigUInt64BE(BigInt(position));
  writeIndexBytes(records, record.length, position, wrote.records);
  writeIndexBytes(records, record.document, position + 4, wrote.records);
  if (record.privateBytes)
    writeIndexBytes(records, record.privateBytes, position + 4 + record.document.length, wrote.records);
  writeIndexBytes(order, offset, index * 8, wrote.offsets);
}
