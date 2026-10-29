import { closeSync, constants, fstatSync, lstatSync, read } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { safeCheckpointPath } from "@pstdio/pocketcoder-contracts";
import { openBackupMember } from "../database/backup-native-file";
import type { openCheckpointDirectory } from "./directory-reader";
import { assertCheckpointCustody } from "./source-custody";

const readChunk = promisify(read);
interface FileOptions {
  signal?: AbortSignal;
  check(): void;
}

export function openCheckpointSourceFile(
  parent: ReturnType<typeof openCheckpointDirectory>,
  name: string,
  custody: Buffer,
  options: FileOptions,
) {
  if (!safeCheckpointPath(name) || name.includes("/")) throw new Error("Unsafe checkpoint filename.");
  options.signal?.throwIfAborted();
  options.check();
  parent.validate();
  const descriptor = openBackupMember(parent.descriptor, name, constants.O_RDONLY);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || (opened.mode & 0o6000n) !== 0n)
      throw new Error("Checkpoint source must be a regular file without hard links or special modes.");
    if (opened.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Checkpoint source file is too large.");
    const expected = Buffer.from(custody);
    const size = Number(opened.size);
    let offset = 0;
    let closed = false;
    let reading: Promise<Buffer | null> | undefined;
    let closing: Promise<void> | undefined;
    function validate() {
      if (closed) throw new Error("Checkpoint source file is closed.");
      options.signal?.throwIfAborted();
      options.check();
      if (closed) throw new Error("Checkpoint source file is closed.");
      options.signal?.throwIfAborted();
      parent.validate();
      assertCheckpointCustody(fstatSync(descriptor, { bigint: true }), expected);
      assertCheckpointCustody(lstatSync(join(parent.path, name), { bigint: true }), expected);
      parent.validateNative();
      if (closed) throw new Error("Checkpoint source file is closed.");
      options.signal?.throwIfAborted();
    }
    validate();
    async function next() {
      validate();
      if (offset === size) return null;
      const bytes = Buffer.alloc(Math.min(65_536, size - offset));
      const operation = readChunk(descriptor, bytes, 0, bytes.length, offset);
      const result = await operation;
      validate();
      if (!result.bytesRead) throw new Error("Checkpoint source file ended early.");
      offset += result.bytesRead;
      return bytes.subarray(0, result.bytesRead);
    }
    return {
      descriptor,
      validate,
      read() {
        if (reading) return Promise.reject(new Error("Checkpoint source read is already running."));
        const task = next();
        reading = task;
        const settled = () => {
          if (reading === task) reading = undefined;
        };
        void task.then(settled, settled);
        return task;
      },
      close() {
        closing ??= (async () => {
          closed = true;
          try {
            if (reading) await Promise.allSettled([reading]);
          } finally {
            closeSync(descriptor);
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}
