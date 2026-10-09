import { fstatSync } from "node:fs";
import { CHECKPOINT_ENTRY_BYTES, safeCheckpointPath } from "@pstdio/pocketcoder-contracts";
import { createBackupFile } from "../database/backup-native-file";
import { readIndexBytes, writeIndexBytes } from "./index-io";

interface DirectoryRecord {
  mount: number;
  path: string;
  custody: Buffer;
}
interface QueueOptions {
  maxBytes: number;
  signal?: AbortSignal;
  check(): void;
}
const fixedBytes = 1 + 64;
function validPath(path: string) {
  return path === "" || safeCheckpointPath(path);
}
function encode(record: DirectoryRecord) {
  if (
    !Number.isInteger(record.mount) ||
    record.mount < 0 ||
    record.mount > 15 ||
    typeof record.path !== "string" ||
    !validPath(record.path) ||
    !Buffer.isBuffer(record.custody) ||
    record.custody.length !== 64
  )
    throw new Error("Invalid checkpoint directory record.");
  const size = fixedBytes + Buffer.byteLength(record.path);
  if (size > CHECKPOINT_ENTRY_BYTES) throw new Error("Checkpoint directory record is too large.");
  const body = Buffer.alloc(size);
  body[0] = record.mount;
  record.custody.copy(body, 1);
  body.write(record.path, fixedBytes, "utf8");
  return body;
}
function decode(body: Buffer): DirectoryRecord {
  const pathBytes = body.subarray(fixedBytes);
  const path = pathBytes.toString("utf8");
  const mount = body[0];
  if (mount === undefined || mount > 15 || !Buffer.from(path).equals(pathBytes) || !validPath(path))
    throw new Error("Invalid checkpoint directory record.");
  return { mount, path, custody: Buffer.from(body.subarray(1, fixedBytes)) };
}

export function createCheckpointDirectoryQueue(directory: string, options: QueueOptions) {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)
    throw new Error("Invalid checkpoint directory queue reservation.");
  options.signal?.throwIfAborted();
  let closed = false;
  let closingFile = false;
  function authority() {
    if (!closingFile) {
      if (closed) throw new Error("Checkpoint directory queue is closed.");
      options.signal?.throwIfAborted();
    }
    options.check();
    if (!closingFile) {
      if (closed) throw new Error("Checkpoint directory queue is closed.");
      options.signal?.throwIfAborted();
    }
  }
  const file = createBackupFile(directory, authority);
  let written = 0;
  let read = 0;
  let count = 0;
  let operations = 0;
  let failure: { error: unknown } | undefined;
  let pending: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  function validate() {
    if (failure) throw failure.error;
    file.validate();
  }
  async function boundary() {
    validate();
    if (++operations % 64 === 0) await Bun.sleep(0);
    validate();
  }
  function run<T>(work: () => T) {
    if (closed) return Promise.reject(new Error("Checkpoint directory queue is closed."));
    if (pending) return Promise.reject(new Error("Checkpoint directory queue work is already running."));
    const task = Promise.resolve().then(async () => {
      await boundary();
      return work();
    });
    pending = task;
    const settled = () => {
      if (pending === task) pending = undefined;
    };
    void task.then(settled, settled);
    return task;
  }
  return {
    get bytes() {
      return written;
    },
    get count() {
      return count;
    },
    append(record: DirectoryRecord) {
      return run(() => {
        const body = encode(record);
        const next = written + 4 + body.length;
        if (!Number.isSafeInteger(next) || next > options.maxBytes)
          throw new Error("Checkpoint directory queue exceeds its physical reservation.");
        const length = Buffer.alloc(4);
        length.writeUInt32BE(body.length);
        try {
          writeIndexBytes(file, length, written);
          writeIndexBytes(file, body, written + 4);
          validate();
        } catch (error) {
          failure = { error };
          // A post-write fence may reject even after only the framing reached disk.
          written = Number(fstatSync(file.descriptor, { bigint: true }).size);
          throw error;
        }
        written = next;
        count++;
      });
    },
    take() {
      return run(() => {
        if (read === written) return null;
        try {
          const size = readIndexBytes(file, 4, read).readUInt32BE();
          if (size < fixedBytes || size > CHECKPOINT_ENTRY_BYTES || read + 4 + size > written)
            throw new Error("Invalid checkpoint directory record size.");
          const record = decode(readIndexBytes(file, size, read + 4));
          validate();
          read += 4 + size;
          count--;
          return record;
        } catch (error) {
          failure = { error };
          throw error;
        }
      });
    },
    close() {
      closing ??= (async () => {
        closed = true;
        await pending?.catch(() => {});
        // Abort forbids queue work; native close still verifies custody and releases both descriptors.
        closingFile = true;
        await file.close();
      })();
      return closing;
    },
  };
}
