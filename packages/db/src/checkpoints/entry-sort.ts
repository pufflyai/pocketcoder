import type { CheckpointArchiveEntry } from "@pstdio/pocketcoder-contracts";
import { createBackupFile } from "../database/backup-native-file";
import {
  checkpointSortRecord,
  compareCheckpointPaths,
  readCheckpointIndexEntry,
  readCheckpointSourceRecord,
  writeCheckpointSortRecord,
} from "./entry-record";
import { type IndexFile, physicalIndexBytes, readIndexBytes } from "./index-io";
import { mergeCheckpointOffsets } from "./offset-merge";

interface SortOptions {
  maxBytes: number;
  signal?: AbortSignal;
  check(): void;
}

export function createCheckpointEntrySorter(directory: string, options: SortOptions) {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)
    throw new Error("Invalid checkpoint sort reservation.");
  let closed = false;
  let closingFile = false;
  function checkState() {
    if (closed) throw new Error("Checkpoint sort is closed.");
    options.signal?.throwIfAborted();
  }
  function authority() {
    // Closing releases owned handles after cancellation; native custody still runs.
    if (closingFile) return;
    checkState();
    options.check();
    checkState();
  }
  const records = createBackupFile(directory, authority);
  let order: IndexFile;
  try {
    order = createBackupFile(directory, authority);
  } catch (error) {
    void records.close().catch(() => {});
    throw error;
  }
  let target: IndexFile | undefined;
  let targetBytes = 0;
  let recordBytes = 0;
  let orderBytes = 0;
  let peakBytes = 0;
  let count = 0;
  let state: "writing" | "sorting" | "ready" = "writing";
  let failure: unknown;
  let pending: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  let operations = 0;
  function bytes() {
    return recordBytes + orderBytes + targetBytes;
  }
  function accountPhysicalBytes() {
    recordBytes = physicalIndexBytes(records);
    orderBytes = physicalIndexBytes(order);
    targetBytes = target ? physicalIndexBytes(target) : 0;
    peakBytes = Math.max(peakBytes, bytes());
  }
  function validate() {
    if (closed) throw new Error("Checkpoint sort is closed.");
    if (failure) throw failure;
    options.signal?.throwIfAborted();
    records.validate();
    order.validate();
    target?.validate();
  }
  async function boundary() {
    validate();
    if (++operations % 64 === 0) await Bun.sleep(0);
    validate();
  }
  function run<T>(work: () => Promise<T>) {
    if (pending) return Promise.reject(new Error("Checkpoint sort work is already running."));
    const task = Promise.resolve().then(work);
    pending = task;
    const settled = () => {
      if (pending === task) pending = undefined;
    };
    void task.then(settled, settled);
    return task;
  }
  async function recordAt(index: number) {
    await boundary();
    const offset = Number(readIndexBytes(order, 8, index * 8).readBigUInt64BE());
    return readCheckpointSourceRecord(records, recordBytes, offset);
  }
  async function entryAt(index: number) {
    await boundary();
    const offset = Number(readIndexBytes(order, 8, index * 8).readBigUInt64BE());
    return readCheckpointIndexEntry(records, recordBytes, offset);
  }
  function requireReady() {
    validate();
    if (state !== "ready") throw new Error("Checkpoint sort is not sealed.");
  }
  async function find(mount: number, path: string) {
    requireReady();
    let lower = 0;
    let upper = count;
    while (lower < upper) {
      const middle = lower + Math.floor((upper - lower) / 2);
      const entry = await entryAt(middle);
      const comparison = compareCheckpointPaths(entry, { mount, path });
      if (!comparison) return { index: middle, entry };
      if (comparison < 0) lower = middle + 1;
      else upper = middle;
    }
    validate();
    return null;
  }
  async function lookup(mount: number, path: string) {
    return (await find(mount, path))?.entry ?? null;
  }
  async function lookupRecord(mount: number, path: string) {
    const found = await find(mount, path);
    return found ? recordAt(found.index) : null;
  }
  async function* sourceRecords() {
    requireReady();
    for (let index = 0; index < count; index++) yield await recordAt(index);
  }
  async function* entries() {
    requireReady();
    for (let index = 0; index < count; index++) yield await entryAt(index);
  }
  return {
    get bytes() {
      return bytes();
    },
    get peakBytes() {
      return peakBytes;
    },
    append(value: CheckpointArchiveEntry, custody?: Buffer) {
      return run(async () => {
        const record = checkpointSortRecord(value, custody);
        await boundary();
        if (state !== "writing") throw new Error("Checkpoint sort is sealed.");
        const next = recordBytes + record.size;
        const nextCount = count + 1;
        // Reserve the next merge sink while the immutable source offsets remain live.
        const offsetBytes = nextCount * (nextCount > 1 ? 16 : 8);
        if (!Number.isSafeInteger(next + offsetBytes) || next + offsetBytes > options.maxBytes)
          throw new Error("Checkpoint sort exceeds its physical byte reservation.");
        try {
          writeCheckpointSortRecord(records, order, recordBytes, count, record, {
            records(size) {
              recordBytes += size;
              peakBytes = Math.max(peakBytes, bytes());
            },
            offsets(size) {
              orderBytes += size;
              peakBytes = Math.max(peakBytes, bytes());
            },
          });
        } catch (error) {
          accountPhysicalBytes();
          failure = error;
          throw error;
        }
        recordBytes = next;
        count = nextCount;
        orderBytes = count * 8;
        peakBytes = Math.max(peakBytes, bytes());
      });
    },
    seal() {
      return run(async () => {
        validate();
        if (state === "ready") return { count, lookup, entries, lookupRecord, records: sourceRecords };
        state = "sorting";
        try {
          records.seal();
          order.seal();
          for (let width = 1; width < count; width *= 2) {
            await boundary();
            target = createBackupFile(directory, authority);
            await mergeCheckpointOffsets({
              records,
              recordBytes,
              source: order,
              target,
              count,
              width,
              boundary,
              wrote(size) {
                targetBytes = size;
                peakBytes = Math.max(peakBytes, bytes());
              },
            });
            validate();
            target.seal();
            const previous = order;
            order = target;
            target = undefined;
            targetBytes = 0;
            await previous.close();
          }
          validate();
          state = "ready";
          return { count, lookup, entries, lookupRecord, records: sourceRecords };
        } catch (error) {
          if (!closed) accountPhysicalBytes();
          failure = error;
          throw error;
        }
      });
    },
    close() {
      closing ??= (async () => {
        closed = true;
        await pending?.catch(() => {});
        closingFile = true;
        const draining: Promise<unknown>[] = [records.close(), order.close()];
        if (target) draining.push(target.close());
        const ownedFiles = draining.length;
        const results = await Promise.allSettled(draining);
        // An interrupted sort is reported by its caller; close still drains it.
        for (const result of results.slice(0, ownedFiles)) if (result.status === "rejected") throw result.reason;
      })();
      return closing;
    },
  };
}
