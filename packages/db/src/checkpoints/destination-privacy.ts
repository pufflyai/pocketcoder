import { dlopen, FFIType, ptr, toBuffer } from "bun:ffi";

function loadPrivacy() {
  if (process.platform === "darwin")
    return dlopen("/usr/lib/libSystem.B.dylib", {
      acl_get_fd_np: { args: [FFIType.i32, FFIType.i32], returns: FFIType.ptr },
      acl_get_entry: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      acl_free: { args: [FFIType.ptr], returns: FFIType.i32 },
      __error: { args: [], returns: FFIType.ptr },
    });
  return dlopen("libc.so.6", {
    fgetxattr: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
    __errno_location: { args: [], returns: FFIType.ptr },
  });
}
const library = loadPrivacy();
function darwinAcl(descriptor: number) {
  if (!("acl_get_fd_np" in library.symbols)) throw new Error("Darwin ACL API is unavailable.");
  const acl = library.symbols.acl_get_fd_np(descriptor, 0x100);
  if (!acl) {
    const pointer = library.symbols.__error();
    const errno = pointer ? toBuffer(pointer, 0, 4).readInt32LE() : -1;
    if (errno === 2) return;
    throw new Error(`Checkpoint destination ACL cannot be verified (errno ${errno}).`);
  }
  try {
    const entry = Buffer.alloc(8);
    const result = library.symbols.acl_get_entry(acl, 0, ptr(entry));
    if (result === 0) throw new Error("Checkpoint destination parent has an ACL.");
    const errno = library.symbols.__error();
    if (!errno || toBuffer(errno, 0, 4).readInt32LE() !== 22)
      throw new Error("Checkpoint destination ACL enumeration failed.");
  } finally {
    library.symbols.acl_free(acl);
  }
}
export function assertDestinationPrivateAcl(descriptor: number) {
  if ("acl_get_fd_np" in library.symbols) return darwinAcl(descriptor);
  for (const attribute of ["system.posix_acl_access", "system.posix_acl_default"]) {
    const result = library.symbols.fgetxattr(descriptor, ptr(Buffer.from(`${attribute}\0`)), null, 0);
    if (result >= 0) throw new Error("Checkpoint destination parent has an ACL.");
    const pointer = library.symbols.__errno_location();
    const errno = pointer ? toBuffer(pointer, 0, 4).readInt32LE() : -1;
    // ENODATA means no ACL; ENOTSUP means this filesystem cannot store one.
    if (errno !== 61 && errno !== 95)
      throw new Error(`Checkpoint destination ACL cannot be verified (errno ${errno}).`);
  }
}
