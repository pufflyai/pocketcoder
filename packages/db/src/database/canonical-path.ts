import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync, constants, fstatSync, lstatSync, openSync, type Stats } from "node:fs";

function pathResolver() {
  if (process.platform !== "darwin") {
    const library = dlopen("libc.so.6", {
      realpath: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
      readlink: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
    });
    return (_path: string, input: Buffer, resolved: Buffer, descriptor?: number) => {
      if (descriptor === undefined) return Boolean(library.symbols.realpath(ptr(input), ptr(resolved)));
      // The kernel path detects ancestor renames without repeating realpath
      // for every index record. The caller still checks the named inode afresh.
      const link = Buffer.from(`/proc/self/fd/${descriptor}\0`);
      const size = Number(library.symbols.readlink(ptr(link), ptr(resolved), resolved.length));
      if (size < 0 || size >= resolved.length) return false;
      resolved[size] = 0;
      return true;
    };
  }
  // The kernel entry point has fixed arguments; libc's fcntl wrapper is variadic.
  const library = dlopen("/usr/lib/libSystem.B.dylib", {
    __fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  });
  const F_GETPATH = 50;
  // Paired with the caller's inode check, the held descriptor's current path
  // detects ancestor renames without walking the same path for every record.
  return (path: string, _input: Buffer, resolved: Buffer, heldDescriptor?: number) => {
    if (heldDescriptor !== undefined) return library.symbols.__fcntl(heldDescriptor, F_GETPATH, ptr(resolved)) === 0;
    let descriptor: number;
    try {
      descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
    } catch {
      return false;
    }
    try {
      // Open afresh so a renamed ancestor or changed alias is never cached.
      return library.symbols.__fcntl(descriptor, F_GETPATH, ptr(resolved)) === 0;
    } finally {
      closeSync(descriptor);
    }
  };
}
const resolvePath = pathResolver();

function readHeldDirectory(path: string, descriptor: number) {
  try {
    const held = fstatSync(descriptor);
    const named = lstatSync(path);
    // Darwin can report the old path even after this directory was unlinked.
    return named.isDirectory() && named.dev === held.dev && named.ino === held.ino ? named : undefined;
  } catch {
    return undefined;
  }
}

export function canonicalPathCheck(
  path: string,
  destination = path,
  descriptor?: number,
  validateNamed?: (stat: Stats) => void,
) {
  if (path.includes("\0") || destination.includes("\0")) throw new Error("Invalid directory path.");
  const input = Buffer.from(`${path}\0`);
  const expected = Buffer.from(`${destination}\0`);
  // PATH_MAX is 1024 on Darwin and 4096 on the supported glibc Linux targets.
  const resolved = Buffer.alloc(4096);
  return () => {
    if (descriptor !== undefined) {
      const named = readHeldDirectory(path, descriptor);
      if (!named) return false;
      // Share this boundary's fresh inode check with the owner's mode check.
      validateNamed?.(named);
    }
    return (
      resolvePath(path, input, resolved, path === destination ? descriptor : undefined) &&
      resolved.subarray(0, expected.length).equals(expected)
    );
  };
}
