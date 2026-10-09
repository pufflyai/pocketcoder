import { dlopen, FFIType } from "bun:ffi";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";

const library = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});
const LOCK_EX = 2;
const LOCK_NB = 4;

export function lockDataFolder(directory: string) {
  const requested = resolve(directory);
  mkdirSync(requested, { recursive: true, mode: 0o700 });
  const dir = realpathSync(requested);
  const descriptor = openSync(join(dir, "LOCK"), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  if (library.symbols.flock(descriptor, LOCK_EX | LOCK_NB) !== 0) {
    closeSync(descriptor);
    throw new Error(`data folder is in use: ${dir}`);
  }
  let closed = false;
  try {
    fchmodSync(descriptor, 0o600);
    const root = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fchmodSync(root, 0o700);
      fsyncSync(root);
    } finally {
      closeSync(root);
    }
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
  return {
    dir,
    close() {
      if (closed) return;
      closed = true;
      // Closing the descriptor also releases the kernel lock after SIGKILL.
      closeSync(descriptor);
    },
  };
}

export function syncDirectory(directory: string) {
  const descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function syncSeed(directory: string) {
  chmodSync(directory, 0o700);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) syncSeed(path);
    else {
      const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        fchmodSync(descriptor, 0o600);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    }
  }
  syncDirectory(directory);
}
