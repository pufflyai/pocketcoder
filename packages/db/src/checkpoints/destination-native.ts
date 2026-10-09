import { dlopen, FFIType, ptr, toBuffer } from "bun:ffi";
import { constants } from "node:fs";
import { safeCheckpointPath } from "@pstdio/pocketcoder-contracts";
import { nativeDestinationStat } from "./destination-stat";

const openSpec = { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 } as const;
const common = {
  mkdirat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  symlinkat: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  readlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
  fchmodat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
} as const;
const library =
  process.platform === "darwin"
    ? dlopen("/usr/lib/libSystem.B.dylib", {
        ...common,
        __openat: openSpec,
        __error: { args: [], returns: FFIType.ptr },
      })
    : dlopen("libc.so.6", { ...common, openat: openSpec, __errno_location: { args: [], returns: FFIType.ptr } });
const openAt = "__openat" in library.symbols ? library.symbols.__openat : library.symbols.openat;
const error = "__error" in library.symbols ? library.symbols.__error : library.symbols.__errno_location;
export const destinationNoFollow = process.platform === "darwin" ? 0x20 : 0x100;

export function destinationName(name: string) {
  if (!safeCheckpointPath(name) || name.includes("/")) throw new Error("Unsafe checkpoint destination name.");
  return Buffer.from(`${name}\0`);
}
export function destinationResult(result: number | bigint, operation: string) {
  if (result >= 0) return Number(result);
  const pointer = error();
  const errno = pointer ? toBuffer(pointer, 0, 4).readInt32LE() : -1;
  throw new Error(`Checkpoint destination ${operation} failed (errno ${errno}).`);
}
export function destinationOpen(parent: number, name: string, flags: number, mode = 0o600) {
  return destinationResult(
    openAt(parent, ptr(destinationName(name)), flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, mode),
    "open",
  );
}
export function destinationOpenDirectorySelf(parent: number) {
  return destinationResult(
    openAt(parent, ptr(Buffer.from(".\0")), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW, 0),
    "directory open",
  );
}
export function destinationStat(parent: number, name: string) {
  return nativeDestinationStat(parent, destinationName(name), destinationNoFollow);
}
export function destinationMkdir(parent: number, name: string) {
  destinationResult(library.symbols.mkdirat(parent, ptr(destinationName(name)), 0o700), "mkdir");
  destinationChmod(parent, name, 0o700);
}
const renameSpec = {
  args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
  returns: FFIType.i32,
} as const;
function renameLibrary() {
  if (process.platform === "darwin") return dlopen("/usr/lib/libSystem.B.dylib", { renameatx_np: renameSpec });
  return dlopen("libc.so.6", { renameat2: renameSpec });
}
let rename: ReturnType<typeof renameLibrary> | undefined;
export function destinationRenameNoReplace(sourceParent: number, source: string, targetParent: number, target: string) {
  rename ??= renameLibrary();
  const move = "renameatx_np" in rename.symbols ? rename.symbols.renameatx_np : rename.symbols.renameat2;
  const flags = process.platform === "darwin" ? 4 : 1;
  destinationResult(
    move(sourceParent, ptr(destinationName(source)), targetParent, ptr(destinationName(target)), flags),
    "exclusive rename",
  );
}
export function destinationSymlink(parent: number, name: string, target: string) {
  if (target.includes("\0")) throw new Error("Unsafe checkpoint link target.");
  destinationResult(
    library.symbols.symlinkat(ptr(Buffer.from(`${target}\0`)), parent, ptr(destinationName(name))),
    "symlink",
  );
}
export function destinationReadlink(parent: number, name: string) {
  const bytes = Buffer.alloc(16 * 1024);
  const size = destinationResult(
    library.symbols.readlinkat(parent, ptr(destinationName(name)), ptr(bytes), bytes.length),
    "readlink",
  );
  if (size === bytes.length) throw new Error("Checkpoint destination link is too large.");
  const value = bytes.subarray(0, size);
  const text = value.toString("utf8");
  if (!Buffer.from(text).equals(value)) throw new Error("Checkpoint destination link is invalid UTF-8.");
  return text;
}
export function destinationChmod(parent: number, name: string, mode: number) {
  if (destinationStat(parent, name).isSymbolicLink())
    throw new Error("Checkpoint destination mode cannot follow a link.");
  destinationResult(library.symbols.fchmodat(parent, ptr(destinationName(name)), mode, destinationNoFollow), "chmod");
}
export function destinationUnlink(parent: number, name: string, directory: boolean) {
  const directoryFlag = process.platform === "darwin" ? 0x80 : 0x200;
  const flag = directory ? directoryFlag : 0;
  destinationResult(library.symbols.unlinkat(parent, ptr(destinationName(name)), flag), "unlink");
}
