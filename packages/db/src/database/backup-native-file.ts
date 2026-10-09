import { dlopen, FFIType, ptr } from "bun:ffi";
import { randomUUID } from "node:crypto";
import { type BigIntStats, closeSync, constants, fstatSync, fsyncSync } from "node:fs";
import { createDatabaseFileStreams } from "./backup-file-stream";
import { openDataDirectory } from "./directory-identity";

const openSpec = { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 } as const;
const library =
  process.platform === "darwin"
    ? dlopen("/usr/lib/libSystem.B.dylib", {
        __openat: openSpec,
        unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      })
    : dlopen("libc.so.6", {
        openat: openSpec,
        unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      });
const openAt = "__openat" in library.symbols ? library.symbols.__openat : library.symbols.openat;

function unlinkOwnedExport(directory: number, name: Buffer, file: number) {
  const current = openBackupMember(directory, name.toString().slice(0, -1), constants.O_RDONLY);
  try {
    const held = fstatSync(file, { bigint: true });
    const named = fstatSync(current, { bigint: true });
    if (held.dev !== named.dev || held.ino !== named.ino || !named.isFile())
      throw new Error("Private database export name was replaced.");
    if (library.symbols.unlinkat(directory, ptr(name), 0) !== 0)
      throw new Error("Private database export cannot be unlinked.");
  } finally {
    closeSync(current);
  }
}

function createAnonymousFile(folder: ReturnType<typeof openDataDirectory>) {
  if (process.platform === "linux") {
    // O_TMPFILE includes O_DIRECTORY, whose value differs on ARM64.
    const O_TMPFILE = 0x400000 | constants.O_DIRECTORY;
    const file = openAt(folder.descriptor, ptr(Buffer.from(".\0")), constants.O_RDWR | O_TMPFILE, 0o600);
    if (file < 0) throw new Error("Controller filesystem must support anonymous database exports.");
    return file;
  }
  const name = Buffer.from(`.database-export-${randomUUID()}\0`);
  const file = openBackupMember(
    folder.descriptor,
    name.toString().slice(0, -1),
    constants.O_RDWR | constants.O_CREAT | constants.O_EXCL,
  );
  try {
    folder.validate();
    // macOS has no O_TMPFILE. No await occurs between private create and unlink.
    unlinkOwnedExport(folder.descriptor, name, file);
    fsyncSync(folder.descriptor);
    return file;
  } catch (error) {
    try {
      unlinkOwnedExport(folder.descriptor, name, file);
    } catch {
      /* Never unlink a replacement. */
    }
    closeSync(file);
    throw error;
  }
}

export function openBackupMember(directory: number, name: string, flags: number) {
  if (!name || name === "." || name === ".." || /[/\\\0]/.test(name)) throw new Error("Unsafe database member name.");
  const descriptor = openAt(
    directory,
    ptr(Buffer.from(`${name}\0`)),
    flags | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  );
  if (descriptor < 0) throw new Error("Database member cannot be opened without following links.");
  return descriptor;
}

export function createBackupFile(directory: string, check: () => void) {
  const folder = openDataDirectory(directory);
  let descriptor: number | undefined;
  try {
    check();
    descriptor = createAnonymousFile(folder);
    const file = descriptor;
    let closed = false;
    let sealed: BigIntStats | undefined;
    const validate = () => {
      if (closed) throw new Error("Database export is closed.");
      check();
      folder.validate();
      const stat = fstatSync(file, { bigint: true });
      if (!stat.isFile() || stat.nlink !== 0n || (stat.mode & 0o777n) !== 0o600n)
        throw new Error("Database export custody changed.");
      if (sealed && (stat.size !== sealed.size || stat.mtimeNs !== sealed.mtimeNs || stat.ctimeNs !== sealed.ctimeNs))
        throw new Error("Sealed database export changed.");
    };
    const streams = createDatabaseFileStreams(file, validate);
    let closing: Promise<void> | undefined;
    const close = () => {
      closing ??= (async () => {
        try {
          await streams.drain();
          validate();
        } finally {
          closed = true;
          closeSync(file);
          folder.close();
        }
      })();
      return closing;
    };
    validate();
    return {
      descriptor: file,
      validate,
      close,
      seal() {
        validate();
        fsyncSync(file);
        sealed = fstatSync(file, { bigint: true });
        validate();
        const size = Number(sealed.size);
        return { size, stream: () => streams.stream(size) };
      },
    };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    folder.close();
    throw error;
  }
}
