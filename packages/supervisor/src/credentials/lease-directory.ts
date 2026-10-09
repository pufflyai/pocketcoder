import { dlopen, FFIType, ptr, read } from "bun:ffi";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, writeFileSync } from "node:fs";

const openSpec = { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 } as const;
// Darwin's fixed openat entry preserves the mode argument on ARM64.
const library =
  process.platform === "darwin"
    ? dlopen("/usr/lib/libSystem.B.dylib", { __openat: openSpec })
    : dlopen("libc.so.6", { openat: openSpec });
const openAt = "__openat" in library.symbols ? library.symbols.__openat : library.symbols.openat;
const native = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
  renameat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
});
const errors =
  process.platform === "darwin"
    ? dlopen("/usr/lib/libSystem.B.dylib", { __error: { args: [], returns: FFIType.u64 } })
    : dlopen("libc.so.6", { __errno_location: { args: [], returns: FFIType.u64 } });
const errno = "__error" in errors.symbols ? errors.symbols.__error : errors.symbols.__errno_location;

export function openLeaseDirectory(path: string) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  if ((fstatSync(descriptor).mode & 0o777) !== 0o700) {
    closeSync(descriptor);
    throw new Error("Workspace lease directory must have mode 0700.");
  }
  let closed = false;
  function remove(name: string) {
    const value = Buffer.from(`${name}\0`);
    if (native.symbols.unlinkat(descriptor, ptr(value), 0) < 0 && read.i32(errno()) !== 2) {
      throw new Error("Workspace lease file cannot be removed.");
    }
  }
  return {
    write(name: string, credential: string) {
      const stageName = `.lease-${randomUUID()}`;
      const stage = Buffer.from(`${stageName}\0`);
      const target = Buffer.from(`${name}\0`);
      const file = openAt(
        descriptor,
        ptr(stage),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      if (file < 0) throw new Error("Workspace lease file cannot be created.");
      try {
        try {
          writeFileSync(file, credential);
        } finally {
          closeSync(file);
        }
        if (native.symbols.renameat(descriptor, ptr(stage), descriptor, ptr(target)) < 0) {
          throw new Error("Workspace lease file cannot be installed.");
        }
      } finally {
        remove(stageName);
      }
    },
    remove,
    close() {
      if (closed) return;
      closed = true;
      closeSync(descriptor);
    },
  };
}
