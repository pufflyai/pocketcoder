import { dlopen, FFIType, toBuffer } from "bun:ffi";

const spec = {
  fdopendir: { args: [FFIType.i32], returns: FFIType.ptr },
  closedir: { args: [FFIType.ptr], returns: FFIType.i32 },
} as const;
function openLibrary() {
  if (process.platform !== "darwin")
    return dlopen("libc.so.6", {
      ...spec,
      readdir64: { args: [FFIType.ptr], returns: FFIType.ptr },
      __errno_location: { args: [], returns: FFIType.ptr },
    });
  if (process.arch === "arm64")
    return dlopen("/usr/lib/libSystem.B.dylib", {
      ...spec,
      readdir: { args: [FFIType.ptr], returns: FFIType.ptr },
      __error: { args: [], returns: FFIType.ptr },
    });
  return dlopen("/usr/lib/libSystem.B.dylib", {
    ...spec,
    readdir$INODE64: { args: [FFIType.ptr], returns: FFIType.ptr },
    __error: { args: [], returns: FFIType.ptr },
  });
}
const library = openLibrary();
function readEntry() {
  if ("readdir" in library.symbols) return library.symbols.readdir;
  if ("readdir$INODE64" in library.symbols) return library.symbols.readdir$INODE64;
  return library.symbols.readdir64;
}
const next = readEntry();
const error = "__error" in library.symbols ? library.symbols.__error : library.symbols.__errno_location;

export function createNativeDirectory(descriptor: number) {
  const directory = library.symbols.fdopendir(descriptor);
  if (!directory) throw new Error("Checkpoint directory stream cannot be opened.");
  return {
    read() {
      const errorPointer = error();
      if (!errorPointer) throw new Error("Native directory errno is unavailable.");
      const errno = toBuffer(errorPointer, 0, 4);
      errno.writeInt32LE(0);
      const record = next(directory);
      if (!record) {
        if (errno.readInt32LE() !== 0) throw new Error("Checkpoint directory read failed.");
        return undefined;
      }
      // These layouts come from Darwin's 64-bit dirent and glibc's dirent64.
      const nameOffset = process.platform === "darwin" ? 21 : 19;
      const maximum = process.platform === "darwin" ? 1048 : 280;
      const length = toBuffer(record, 0, 18).readUInt16LE(16);
      if (length <= nameOffset || length > maximum) throw new Error("Invalid native directory record.");
      const bytes = toBuffer(record, nameOffset, length - nameOffset);
      const end = bytes.indexOf(0);
      if (end < 0) throw new Error("Invalid native directory name.");
      const nameBytes = bytes.subarray(0, end);
      const name = nameBytes.toString("utf8");
      if (!Buffer.from(name).equals(nameBytes)) throw new Error("Checkpoint filename has invalid UTF-8.");
      return name;
    },
    close() {
      if (library.symbols.closedir(directory) !== 0) throw new Error("Checkpoint directory close failed.");
    },
  };
}
