import { dlopen, FFIType, ptr, toBuffer } from "bun:ffi";
import { expect, test } from "bun:test";
import { closeSync, constants, mkdtempSync, openSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDestinationPrivateAcl } from "./destination-privacy";

if (process.platform === "linux") {
  const native = dlopen("libc.so.6", {
    fsetxattr: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
    __errno_location: { args: [], returns: FFIType.ptr },
  });
  const attribute = Buffer.from("system.posix_acl_access\0");
  const acl = Buffer.alloc(44);
  acl.writeUInt32LE(2);
  const entries = [
    [1, 7, 0xffffffff],
    [2, 7, 2000],
    [4, 0, 0xffffffff],
    [16, 7, 0xffffffff],
    [32, 0, 0xffffffff],
  ] as const;
  for (const [index, [tag, permissions, id]] of entries.entries()) {
    acl.writeUInt16LE(tag, 4 + index * 8);
    acl.writeUInt16LE(permissions, 6 + index * 8);
    acl.writeUInt32LE(id, 8 + index * 8);
  }
  function withDirectory(parent: string, run: (descriptor: number) => void) {
    const directory = realpathSync(mkdtempSync(join(parent, "pc-checkpoint-acl-")));
    const descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      run(descriptor);
    } finally {
      closeSync(descriptor);
      rmSync(directory, { recursive: true });
    }
  }
  function setAcl(descriptor: number) {
    return native.symbols.fsetxattr(descriptor, ptr(attribute), ptr(acl), acl.length, 0);
  }

  test("private Linux tmpfs admits absent ACLs and rejects supported ACLs", () => {
    withDirectory(process.env.PC78_CHECKPOINT_TMPFS ?? "/dev/shm", (descriptor) => {
      expect(() => assertDestinationPrivateAcl(descriptor)).not.toThrow();
      const result = setAcl(descriptor);
      const pointer = native.symbols.__errno_location();
      if (!pointer) throw new Error("Linux errno pointer is unavailable.");
      const errno = toBuffer(pointer, 0, 4).readInt32LE();
      if (result === 0) {
        expect(() => assertDestinationPrivateAcl(descriptor)).toThrow("has an ACL");
      } else {
        // The native refusal proves this filesystem cannot store an ACL.
        expect(result).toBe(-1);
        expect(errno).toBe(95);
        expect(() => assertDestinationPrivateAcl(descriptor)).not.toThrow();
      }
    });
  });

  test("supported Linux filesystem rejects a real named-user ACL", () => {
    withDirectory(tmpdir(), (descriptor) => {
      expect(() => assertDestinationPrivateAcl(descriptor)).not.toThrow();
      expect(setAcl(descriptor)).toBe(0);
      expect(() => assertDestinationPrivateAcl(descriptor)).toThrow("has an ACL");
    });
  });

  test("Linux ACL verification refuses an invalid descriptor", () => {
    expect(() => assertDestinationPrivateAcl(-1)).toThrow("cannot be verified");
  });
}
