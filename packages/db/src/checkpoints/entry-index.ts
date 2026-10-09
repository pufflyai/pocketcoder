import { fstatSync } from "node:fs";
import {
  CHECKPOINT_ENTRY_BYTES,
  type CheckpointArchiveEntry,
  CheckpointArchiveEntrySchema,
  canonicalJson,
  checkpointDocument,
} from "@pstdio/pocketcoder-contracts";
import { createBackupFile } from "../database/backup-native-file";
import { physicalIndexBytes, readIndexBytes, writeIndexBytes } from "./index-io";

interface IndexOptions {
  maxBytes: number;
  signal?: AbortSignal;
  check(): void;
}

function compare(left: { mount: number; path: string }, right: { mount: number; path: string }) {
  return left.mount - right.mount || Buffer.compare(Buffer.from(left.path), Buffer.from(right.path));
}

export function createCheckpointEntryIndex(directory: string, options: IndexOptions) {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)
    throw new Error("Invalid checkpoint index reservation.");
  let closed = false;
  let closingFile = false;
  let acceptingRead = false;
  function checkState() {
    if (closed) throw new Error("Checkpoint index is closed.");
    options.signal?.throwIfAborted();
  }
  function authority() {
    if (!closingFile) checkState();
    if (!acceptingRead) options.check();
    if (!closingFile) checkState();
  }
  const records = createBackupFile(directory, authority);
  let offsets: ReturnType<typeof createBackupFile>;
  try {
    offsets = createBackupFile(directory, authority);
  } catch (error) {
    // No stream has started; close still releases the descriptor if authority changed.
    void records.close().catch(() => {});
    throw error;
  }
  let count = 0;
  let recordBytes = 0;
  let offsetBytes = 0;
  let previous: CheckpointArchiveEntry | undefined;
  let sealed = false;
  let pending: Promise<unknown> | undefined;
  let failure: unknown;
  let operations = 0;
  let closing: Promise<void> | undefined;

  function validate() {
    if (closed) throw new Error("Checkpoint index is closed.");
    if (failure) throw failure;
    options.signal?.throwIfAborted();
    records.validate();
    offsets.validate();
  }
  async function boundary() {
    validate();
    // Resolved promises do not yield to socket cancellation or timers.
    if (++operations % 64 === 0) await Bun.sleep(0);
    validate();
  }
  function run<T>(work: () => Promise<T>) {
    if (pending) return Promise.reject(new Error("Checkpoint index append is already running."));
    const task = Promise.resolve().then(work);
    pending = task;
    const settled = () => {
      if (pending === task) pending = undefined;
    };
    void task.then(settled, settled);
    return task;
  }
  async function entryAt(index: number) {
    await boundary();
    const offset = Number(readIndexBytes(offsets, 8, index * 8).readBigUInt64BE());
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + 4 > recordBytes)
      throw new Error("Invalid checkpoint index offset.");
    const length = readIndexBytes(records, 4, offset).readUInt32BE();
    if (length > CHECKPOINT_ENTRY_BYTES || offset + 4 + length > recordBytes)
      throw new Error("Invalid checkpoint index record size.");
    return Object.freeze(
      checkpointDocument(readIndexBytes(records, length, offset + 4), CheckpointArchiveEntrySchema, "index"),
    );
  }
  function requireSealed() {
    validate();
    if (!sealed) throw new Error("Checkpoint index is not sealed.");
  }
  function acceptRead() {
    // Caller callbacks run during reads; acceptance ends with owned native facts.
    acceptingRead = true;
    try {
      requireSealed();
    } finally {
      acceptingRead = false;
    }
  }
  async function find(mount: number, path: string) {
    requireSealed();
    const key = { mount, path };
    let lower = 0;
    let upper = count;
    while (lower < upper) {
      const middle = lower + Math.floor((upper - lower) / 2);
      const entry = await entryAt(middle);
      acceptRead();
      const order = compare(entry, key);
      if (order === 0) return { entry, ordinal: middle };
      if (order < 0) lower = middle + 1;
      else upper = middle;
    }
    validate();
    return null;
  }
  async function lookup(mount: number, path: string) {
    const result = await find(mount, path);
    acceptRead();
    return result?.entry ?? null;
  }
  async function ordinal(mount: number, path: string) {
    const result = await find(mount, path);
    acceptRead();
    return result?.ordinal ?? null;
  }
  async function at(index: number) {
    requireSealed();
    if (!Number.isSafeInteger(index) || index < 0 || index >= count)
      throw new Error("Invalid checkpoint entry ordinal.");
    const result = await entryAt(index);
    acceptRead();
    return result;
  }
  async function* entries(options: { reverse?: boolean } = {}) {
    requireSealed();
    for (let offset = 0; offset < count; offset++) {
      const entry = await entryAt(options.reverse ? count - 1 - offset : offset);
      acceptRead();
      yield entry;
    }
    await boundary();
    acceptRead();
  }
  return {
    get allocatedBytes() {
      return Number(
        (fstatSync(records.descriptor, { bigint: true }).blocks +
          fstatSync(offsets.descriptor, { bigint: true }).blocks) *
          512n,
      );
    },
    get bytes() {
      return recordBytes + offsetBytes;
    },
    append(value: CheckpointArchiveEntry) {
      return run(async () => {
        validate();
        if (sealed) throw new Error("Checkpoint index is sealed.");
        await boundary();
        const entry = CheckpointArchiveEntrySchema.parse(value);
        if (previous && compare(previous, entry) >= 0)
          throw new Error("Checkpoint index entries are duplicate or out of order.");
        const document = Buffer.from(canonicalJson(entry));
        if (document.length > CHECKPOINT_ENTRY_BYTES) throw new Error("Checkpoint index record is too large.");
        const nextBytes = recordBytes + 4 + document.length;
        if (!Number.isSafeInteger(nextBytes + (count + 1) * 8) || nextBytes + (count + 1) * 8 > options.maxBytes)
          throw new Error("Checkpoint index exceeds its physical byte reservation.");
        const length = Buffer.alloc(4);
        length.writeUInt32BE(document.length);
        const offset = Buffer.alloc(8);
        offset.writeBigUInt64BE(BigInt(recordBytes));
        const position = recordBytes;
        const wroteRecord = (size: number) => {
          recordBytes += size;
        };
        const wroteOffset = (size: number) => {
          offsetBytes += size;
        };
        try {
          writeIndexBytes(records, length, position, wroteRecord);
          writeIndexBytes(records, document, position + 4, wroteRecord);
          writeIndexBytes(offsets, offset, count * 8, wroteOffset);
        } catch (error) {
          recordBytes = physicalIndexBytes(records);
          offsetBytes = physicalIndexBytes(offsets);
          failure = error;
          throw error;
        }
        recordBytes = nextBytes;
        count++;
        offsetBytes = count * 8;
        previous = entry;
      });
    },
    seal() {
      validate();
      if (pending) throw new Error("Checkpoint index append is still running.");
      if (!sealed) {
        records.seal();
        offsets.seal();
        sealed = true;
        previous = undefined;
      }
      return { lookup, ordinal, entryAt: at, entries, count, validate: requireSealed };
    },
    close() {
      closing ??= (async () => {
        closed = true;
        await pending?.catch(() => {});
        closingFile = true;
        const results = await Promise.allSettled([records.close(), offsets.close()]);
        for (const result of results) if (result.status === "rejected") throw result.reason;
      })();
      return closing;
    },
  };
}
