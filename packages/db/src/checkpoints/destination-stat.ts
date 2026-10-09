import { dlopen, FFIType, ptr } from "bun:ffi";
import type { BigIntStats } from "node:fs";

export type DestinationStat = Pick<
  BigIntStats,
  | "dev"
  | "ino"
  | "blocks"
  | "size"
  | "mode"
  | "uid"
  | "gid"
  | "nlink"
  | "mtimeNs"
  | "ctimeNs"
  | "isFile"
  | "isDirectory"
  | "isSymbolicLink"
>;
const spec = { args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 } as const;
function openLibrary() {
  if (process.platform === "linux") return dlopen("libc.so.6", { fstatat: spec });
  if (process.arch === "arm64") return dlopen("/usr/lib/libSystem.B.dylib", { fstatat: spec });
  return dlopen("/usr/lib/libSystem.B.dylib", { fstatat$INODE64: spec });
}
const library = openLibrary();
const statAt = "fstatat" in library.symbols ? library.symbols.fstatat : library.symbols.fstatat$INODE64;
function time(bytes: Buffer, offset: number) {
  return bytes.readBigInt64LE(offset) * 1_000_000_000n + bytes.readBigInt64LE(offset + 8);
}
export function nativeDestinationStat(parent: number, name: Buffer, flags: number): DestinationStat {
  // Darwin stat64 is 144 bytes. Linux glibc stat is 144 (x64) or 128 (arm64).
  const bytes = Buffer.alloc(144);
  if (statAt(parent, ptr(name), ptr(bytes), flags) !== 0) throw new Error("Checkpoint destination stat failed.");
  const darwin = process.platform === "darwin";
  const armLinux = !darwin && process.arch === "arm64";
  let uidOffset = armLinux ? 24 : 28;
  if (darwin) uidOffset = 16;
  let mode: bigint;
  let nlink: bigint;
  if (darwin) {
    mode = BigInt(bytes.readUInt16LE(4));
    nlink = BigInt(bytes.readUInt16LE(6));
  } else {
    mode = BigInt(bytes.readUInt32LE(armLinux ? 16 : 24));
    nlink = armLinux ? BigInt(bytes.readUInt32LE(20)) : bytes.readBigUInt64LE(16);
  }
  return {
    dev: darwin ? BigInt(bytes.readUInt32LE(0)) : bytes.readBigUInt64LE(0),
    ino: bytes.readBigUInt64LE(8),
    mode,
    nlink,
    uid: BigInt(bytes.readUInt32LE(uidOffset)),
    gid: BigInt(bytes.readUInt32LE(uidOffset + 4)),
    size: bytes.readBigInt64LE(darwin ? 96 : 48),
    blocks: bytes.readBigInt64LE(darwin ? 104 : 64),
    mtimeNs: time(bytes, darwin ? 48 : 88),
    ctimeNs: time(bytes, darwin ? 64 : 104),
    isFile: () => (mode & 0o170000n) === 0o100000n,
    isDirectory: () => (mode & 0o170000n) === 0o40000n,
    isSymbolicLink: () => (mode & 0o170000n) === 0o120000n,
  };
}
