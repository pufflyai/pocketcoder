import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, write } from "node:fs";
import { join } from "node:path";
import type { CheckpointStageIdentity } from "@pstdio/pocketcoder-runtime-contracts";
import { createDatabaseFileStreams } from "../database/backup-file-stream";
import { openDataDirectory } from "../database/directory-identity";
import { destinationOpen, destinationRenameNoReplace, destinationStat, destinationUnlink } from "./destination-native";
import type { DestinationStat } from "./destination-stat";
import type { VerifiedCheckpointArchive } from "./verified-archive";

function identity(stat: DestinationStat): CheckpointStageIdentity {
  return {
    allocatedBytes: String(stat.blocks * 512n),
    device: String(stat.dev),
    inode: String(stat.ino),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
    mode: Number(stat.mode & 0o777n),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  };
}
function same(stat: DestinationStat, expected: CheckpointStageIdentity) {
  const actual = identity(stat);
  if (
    !stat.isFile() ||
    stat.nlink !== 1n ||
    Object.keys(expected).some(
      (key) => actual[key as keyof CheckpointStageIdentity] !== expected[key as keyof CheckpointStageIdentity],
    )
  )
    throw new Error("Checkpoint archive publication custody changed.");
}
function archiveName(name: string) {
  if (!/^[a-f0-9-]{36}-[a-f0-9-]{36}\.tar$/.test(name)) throw new Error("Invalid checkpoint archive publication name.");
  return name;
}

async function append(file: number, bytes: Uint8Array, offset: number, validate: () => void) {
  let consumed = 0;
  while (consumed < bytes.length) {
    validate();
    const count = await new Promise<number>((resolve, reject) => {
      write(file, bytes, consumed, bytes.length - consumed, offset, (error, written) =>
        error ? reject(error) : resolve(written),
      );
    });
    validate();
    if (!count) throw new Error("Checkpoint publication write made no progress.");
    consumed += count;
    offset += count;
  }
  return offset;
}

async function proveContents(file: number, bytes: number, digest: string, validate: () => void) {
  const streams = createDatabaseFileStreams(file, validate);
  const reader = streams.stream(bytes).getReader();
  const hash = createHash("sha256");
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      hash.update(part.value);
    }
    validate();
    if (`sha256:${hash.digest("hex")}` !== digest)
      throw new Error("Sealed checkpoint archive differs from verified content.");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    await streams.drain();
  }
}

export function createCheckpointArchivePublication(
  directory: string,
  target: string,
  check: () => void,
  maxAllocatedBytes = Number.MAX_SAFE_INTEGER,
) {
  archiveName(target);
  const folder = openDataDirectory(directory);
  const stage = `.${target}.partial`;
  let file: number;
  try {
    check();
    file = destinationOpen(folder.descriptor, stage, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL);
  } catch (error) {
    folder.close();
    throw error;
  }
  const original = identity(fstatSync(file, { bigint: true }));
  let name = stage;
  let sealed: CheckpointStageIdentity | undefined;
  let published = false;
  let proven = false;
  let closed = false;
  let writing: Promise<void> | undefined;
  let input: ReturnType<ReturnType<VerifiedCheckpointArchive["replay"]>["getReader"]> | undefined;
  let closing: Promise<void> | undefined;
  function native() {
    if (closed) throw new Error("Checkpoint archive publication is closed.");
    folder.validate();
    const held = fstatSync(file, { bigint: true });
    const named = destinationStat(folder.descriptor, name);
    if (
      !held.isFile() ||
      held.nlink !== 1n ||
      String(held.dev) !== original.device ||
      String(held.ino) !== original.inode ||
      (held.mode & 0o777n) !== 0o600n
    )
      throw new Error("Checkpoint archive publication custody changed.");
    if (sealed) same(held, sealed);
    same(named, identity(held));
  }
  function validate() {
    check();
    native();
    if (Number(fstatSync(file, { bigint: true }).blocks * 512n) > maxAllocatedBytes)
      throw new Error("Checkpoint publication exceeds its allocated reservation.");
    check();
  }
  return {
    validate,
    identity() {
      validate();
      return identity(fstatSync(file, { bigint: true }));
    },
    write(verified: VerifiedCheckpointArchive) {
      if (writing) throw new Error("Checkpoint archive publication is already writing.");
      writing = (async () => {
        validate();
        const reader = verified.replay().getReader();
        input = reader;
        const hash = createHash("sha256");
        let offset = 0;
        try {
          while (true) {
            const next = await reader.read();
            validate();
            verified.validate();
            if (next.done) break;
            const bytes = next.value;
            hash.update(bytes);
            offset = await append(file, bytes, offset, validate);
          }
          verified.validate();
          if (
            offset !== verified.receipt.archiveBytes ||
            `sha256:${hash.digest("hex")}` !== verified.receipt.archiveDigest
          )
            throw new Error("Checkpoint publication differs from its verified archive.");
          fsyncSync(file);
          sealed = identity(fstatSync(file, { bigint: true }));
          validate();
          await proveContents(file, verified.receipt.archiveBytes, verified.receipt.archiveDigest, validate);
          proven = true;
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
          input = undefined;
        }
      })();
      return writing;
    },
    publish() {
      validate();
      if (!sealed || !proven || published) throw new Error("Checkpoint archive is not sealed for publication.");
      destinationRenameNoReplace(folder.descriptor, name, folder.descriptor, target);
      name = target;
      // Rename changes ctime; the held inode and all content metadata remain authoritative.
      const after = identity(fstatSync(file, { bigint: true }));
      same(fstatSync(file, { bigint: true }), { ...sealed, ctimeNs: after.ctimeNs });
      sealed = after;
      validate();
      fsyncSync(folder.descriptor);
      validate();
      published = true;
      return { ...sealed };
    },
    close(remove = false) {
      closing ??= (async () => {
        try {
          await input?.cancel().catch(() => {});
          await writing?.catch(() => {});
          if (remove || !published) {
            native();
            destinationUnlink(folder.descriptor, name, false);
            fsyncSync(folder.descriptor);
          }
        } finally {
          closed = true;
          closeSync(file);
          folder.close();
        }
      })();
      return closing;
    },
  };
}

export function openCheckpointArchivePublication(
  directory: string,
  name: string,
  expected: CheckpointStageIdentity,
  check: () => void,
) {
  archiveName(name);
  const folder = openDataDirectory(directory);
  let file: number;
  try {
    check();
    file = destinationOpen(folder.descriptor, name, constants.O_RDONLY);
  } catch (error) {
    folder.close();
    throw error;
  }
  let closed = false;
  function validate() {
    if (closed) throw new Error("Checkpoint archive download is closed.");
    check();
    folder.validate();
    same(fstatSync(file, { bigint: true }), expected);
    same(destinationStat(folder.descriptor, name), expected);
    check();
  }
  try {
    validate();
  } catch (error) {
    closeSync(file);
    folder.close();
    throw error;
  }
  const streams = createDatabaseFileStreams(file, validate);
  let removed = false;
  let closing: Promise<void> | undefined;
  return {
    validate,
    stream() {
      validate();
      return streams.stream(Number(expected.size));
    },
    remove() {
      validate();
      destinationUnlink(folder.descriptor, name, false);
      fsyncSync(folder.descriptor);
      removed = true;
    },
    checkRemoved() {
      if (!removed) throw new Error("Checkpoint archive is still owned.");
      folder.validate();
      try {
        lstatSync(join(directory, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          folder.validate();
          return;
        }
        throw error;
      }
      throw new Error("Checkpoint archive name remains after deletion.");
    },
    close() {
      closing ??= (async () => {
        try {
          await streams.drain();
        } finally {
          closed = true;
          closeSync(file);
          folder.close();
        }
      })();
      return closing;
    },
  };
}
