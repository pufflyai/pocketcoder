import { dlopen, FFIType, ptr } from "bun:ffi";
import { destinationName, destinationNoFollow, destinationResult } from "./destination-native";

const library = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
  futimens: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  utimensat: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
});
export function destinationTimestamp(value: string) {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error("Invalid checkpoint destination timestamp.");
  const ns = BigInt(value);
  const seconds = ns / 1_000_000_000n;
  if (seconds > 0x7fffffffffffffffn) throw new Error("Checkpoint timestamp exceeds the native range.");
  const times = Buffer.alloc(32);
  // Preserve atime; both supported 64-bit platforms use two signed 64-bit fields.
  times.writeBigInt64LE(process.platform === "darwin" ? -2n : 1_073_741_822n, 8);
  times.writeBigInt64LE(seconds, 16);
  times.writeBigInt64LE(ns % 1_000_000_000n, 24);
  return times;
}
export function destinationFileTime(descriptor: number, value: string) {
  destinationResult(library.symbols.futimens(descriptor, ptr(destinationTimestamp(value))), "file timestamp");
}
export function destinationLinkTime(parent: number, name: string, value: string) {
  destinationResult(
    library.symbols.utimensat(
      parent,
      ptr(destinationName(name)),
      ptr(destinationTimestamp(value)),
      destinationNoFollow,
    ),
    "entry timestamp",
  );
}
