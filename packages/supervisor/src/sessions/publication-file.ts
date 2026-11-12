import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const signature = { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 } as const;
const library =
  process.platform === "darwin"
    ? dlopen("/usr/lib/libSystem.B.dylib", { __openat: signature })
    : dlopen("libc.so.6", { openat: signature });
const openAt = "__openat" in library.symbols ? library.symbols.__openat : library.symbols.openat;

function openDirectory(parent: number, name: string) {
  const descriptor = openAt(
    parent,
    ptr(Buffer.from(`${name}\0`)),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    0,
  );
  if (descriptor < 0) throw new Error("Publication output roots must not contain links or missing directories");
  return descriptor;
}

function openRoot(path: string) {
  let current = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const name of resolve(path).split(sep).filter(Boolean)) {
      const next = openDirectory(current, name);
      closeSync(current);
      current = next;
    }
    return current;
  } catch (error) {
    closeSync(current);
    throw error;
  }
}

// Every child is opened relative to a held directory, so renames cannot redirect a read through a link.
export function publicationFile(path: string, roots: string[], maxBytes: number) {
  if (!path || path.includes("\0") || path.split(/[\\/]/).includes("..")) throw new Error("Unsafe publication path");
  const absolute = resolve(path);
  const root = roots.find((candidate) => absolute.startsWith(`${resolve(candidate)}${sep}`));
  if (!root) throw new Error("Publication path is outside the declared output roots");
  const parts = relative(resolve(root), absolute).split(sep);
  const rootDescriptor = openRoot(root);
  const descriptors = [rootDescriptor];
  let current = rootDescriptor;
  try {
    const device = fstatSync(rootDescriptor).dev;
    for (const [index, part] of parts.entries()) {
      const directory = index < parts.length - 1;
      const descriptor = openAt(
        current,
        ptr(Buffer.from(`${part}\0`)),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0),
        0,
      );
      if (descriptor < 0) throw new Error("Publication source must not contain links or missing files");
      descriptors.push(descriptor);
      current = descriptor;
      if (fstatSync(descriptor).dev !== device) throw new Error("Publication cannot cross a filesystem boundary");
    }
    const descriptor = current;
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n)
      throw new Error("Publication source must be a regular file without links");
    if (before.size > BigInt(maxBytes)) throw new Error("Publication byte limit exceeded");
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, Math.min(65536, bytes.length - offset), offset);
      if (!count) throw new Error("Publication source changed while being read");
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    const fields = ["dev", "ino", "size", "mtimeNs", "ctimeNs", "nlink", "mode"] as const;
    if (fields.some((key) => before[key] !== after[key]))
      throw new Error("Publication source changed while being read");
    return bytes;
  } finally {
    for (const descriptor of descriptors.reverse()) closeSync(descriptor);
  }
}
