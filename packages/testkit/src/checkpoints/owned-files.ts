import { dlopen, FFIType, ptr } from "bun:ffi";
import { fstatSync, readdirSync, readlinkSync } from "node:fs";

const darwin =
  process.platform === "darwin"
    ? dlopen("/usr/lib/libSystem.B.dylib", {
        __fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      })
    : undefined;
function descriptorPath(fd: number) {
  if (!darwin) return readlinkSync(`/proc/self/fd/${fd}`);
  const buffer = Buffer.alloc(4096);
  if (darwin.symbols.__fcntl(fd, 50, ptr(buffer)) !== 0) return "";
  return buffer.toString("utf8", 0, buffer.indexOf(0));
}
function inventory() {
  return readdirSync("/dev/fd").flatMap((name) => {
    const fd = Number(name);
    try {
      const stat = fstatSync(fd, { bigint: true });
      if (!stat.isFile() && !stat.isDirectory()) return [];
      return [{ fd, stat, identity: `${stat.dev}:${stat.ino}` }];
    } catch {
      // The directory enumeration itself may have already released its FD.
      return [];
    }
  });
}

// Checkpoint tests share a process with PGlite and HTTP fixtures. Only adopt
// new native identities whose kernel path belongs to this private fixture.
export function trackCheckpointFiles(root: string) {
  const baseline = new Set(inventory().map(({ identity }) => identity));
  const owned = new Set<string>();
  function snapshot() {
    const current = inventory();
    for (const file of current) {
      if (baseline.has(file.identity) || owned.has(file.identity)) continue;
      const path = descriptorPath(file.fd);
      if (path === root || path.startsWith(`${root}/`)) owned.add(file.identity);
    }
    return current.filter(({ identity }) => owned.has(identity));
  }
  return {
    snapshot,
    files: () => snapshot().filter(({ stat }) => stat.isFile()),
  };
}
