import { dlopen, FFIType } from "bun:ffi";

const library = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});
const LOCK_EX = 2;
const LOCK_NB = 4;

export function lockWriterDescriptor(descriptor: number, directory: string) {
  if (library.symbols.flock(descriptor, LOCK_EX | LOCK_NB) !== 0)
    throw new Error(`data folder is in use: ${directory}`);
}
