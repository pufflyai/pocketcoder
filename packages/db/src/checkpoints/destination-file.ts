import { createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, write } from "node:fs";
import { promisify } from "node:util";
import type { CheckpointArchiveEntry } from "@pstdio/pocketcoder-contracts";
import { closeDestinationDescriptor } from "./destination-close";
import {
  assertDestinationCustody,
  assertDestinationIdentity,
  type createDestinationCustody,
  destinationCustody,
} from "./destination-custody";
import type { createDestinationDirectories } from "./destination-directory";
import { destinationFileTime } from "./destination-metadata";
import { destinationOpen, destinationStat } from "./destination-native";

const writeChunk = promisify(write);
type Ledger = Awaited<ReturnType<typeof createDestinationCustody>>;
type Directories = ReturnType<typeof createDestinationDirectories>;
export async function openDestinationFile(
  requested: CheckpointArchiveEntry,
  ledger: Ledger,
  directories: Directories,
  check: () => void,
  onClose: () => void,
) {
  if (requested.kind !== "file") throw new Error("Checkpoint destination entry is not a file.");
  const ordinal = await ledger.locate(requested);
  const entry = await ledger.entryAt(ordinal);
  if (entry.kind !== "file") throw new Error("Checkpoint destination entry is not a file.");
  if (ledger.read(ordinal)[0]) throw new Error("Checkpoint destination entry already exists.");
  const parent = await directories.openParent(entry);
  let descriptor: number | undefined;
  try {
    parent.validateNative();
    descriptor = destinationOpen(
      parent.descriptor,
      parent.name,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    );
    fchmodSync(descriptor, 0o600);
    parent.refresh();
    ledger.retain(ordinal, fstatSync(descriptor, { bigint: true }), 1);
    const file = descriptor;
    let expected = destinationCustody(fstatSync(file, { bigint: true }));
    let size = 0;
    const hash = createHash("sha256");
    let closed = false;
    let pending: Promise<unknown> | undefined;
    let closing: Promise<void> | undefined;
    function native() {
      parent.validateNative();
      assertDestinationCustody(fstatSync(file, { bigint: true }), expected);
      assertDestinationCustody(destinationStat(parent.descriptor, parent.name), expected);
      parent.validateNative();
    }
    async function validate() {
      if (closed) throw new Error("Checkpoint destination file is closed.");
      check();
      await directories.validateParents(entry);
      if (closed) throw new Error("Checkpoint destination file is closed.");
      native();
    }
    function close() {
      closing ??= (async () => {
        closed = true;
        try {
          await pending?.catch(() => {});
        } finally {
          try {
            closeDestinationDescriptor(file, expected);
          } finally {
            try {
              parent.close();
            } finally {
              onClose();
            }
          }
        }
      })();
      return closing;
    }
    async function writeBytes(bytes: Uint8Array) {
      await validate();
      if (!bytes.length || bytes.length > 65_536 || size + bytes.length > entry.size)
        throw new Error("Checkpoint destination file exceeds its admitted size or IO bound.");
      const owned = Buffer.from(bytes);
      let offset = 0;
      while (offset < owned.length) {
        await validate();
        const result = await writeChunk(file, owned, offset, owned.length - offset, size);
        // Capture the actual completed write before any caller callback runs.
        const stat = fstatSync(file, { bigint: true });
        assertDestinationIdentity(stat, expected);
        size += result.bytesWritten;
        offset += result.bytesWritten;
        if (stat.size !== BigInt(size) || stat.nlink !== 1n || (stat.mode & 0o777n) !== 0o600n)
          throw new Error("Checkpoint destination file changed during write.");
        expected = destinationCustody(stat);
        ledger.retain(ordinal, stat, 1);
        await validate();
        if (!result.bytesWritten) throw new Error("Checkpoint destination write made no progress.");
      }
      hash.update(owned);
    }
    native();
    return {
      descriptor: file,
      write(bytes: Uint8Array) {
        if (pending) return Promise.reject(new Error("Checkpoint destination file IO is already running."));
        const task = writeBytes(bytes);
        pending = task;
        void task
          .finally(() => {
            if (pending === task) pending = undefined;
          })
          .catch(() => {});
        return task;
      },
      async finish() {
        try {
          if (pending) throw new Error("Checkpoint destination file IO is still running.");
          await validate();
          if (size !== entry.size || `sha256:${hash.digest("hex")}` !== entry.digest)
            throw new Error("Checkpoint destination file digest or size differs.");
          fchmodSync(file, entry.mode);
          destinationFileTime(file, entry.mtime_ns);
          fsyncSync(file);
          const stat = fstatSync(file, { bigint: true });
          assertDestinationIdentity(stat, expected);
          if ((stat.mode & 0o777n) !== BigInt(entry.mode) || stat.mtimeNs !== BigInt(entry.mtime_ns))
            throw new Error("Checkpoint destination file metadata differs.");
          expected = destinationCustody(stat);
          ledger.retain(ordinal, stat, 2);
          await validate();
        } finally {
          await close();
        }
      },
      close,
    };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    parent.close();
    throw error;
  }
}
