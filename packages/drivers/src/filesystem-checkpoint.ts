import { createHash } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import {
  chmod,
  chown,
  copyFile,
  lchown,
  lstat,
  lutimes,
  mkdir,
  readdir,
  readlink,
  rm,
  symlink,
  utimes,
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import type { CheckpointManifest, PersistenceMount } from "@pstdio/pocketcoder-contracts";

interface ScanCounters {
  bytes: number;
  files: number;
}

type ManifestEntry = CheckpointManifest["mounts"][number]["entries"][number];
type WalkDirectory = (directory: string, relativeDirectory: string) => Promise<void>;

interface ScanContext {
  entries: ManifestEntry[];
  counters: ScanCounters;
  mount: PersistenceMount;
  destinationRoot?: string;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

export async function safeOwnership(
  path: string,
  uid: number,
  gid: number,
  directory: boolean,
): Promise<void> {
  try {
    await chown(path, uid, gid);
    await chmod(path, directory ? 0o770 : 0o660);
  } catch {
    // Rootless local development cannot chown to the template UID. The
    // opaque parent remains 0700; only the explicitly mounted child is
    // made writable so Docker Desktop/rootless containers can use it.
    await chmod(path, directory ? 0o777 : 0o666);
  }
}

function safeRelativePath(value: string): boolean {
  if (!value || value.includes("\0") || value.includes("\\")) return false;
  if (value !== value.normalize("NFC")) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export function safeSymlinkTarget(entryPath: string, target: string): boolean {
  if (!target || target.startsWith("/") || target.includes("\0") || target.includes("\\")) {
    return false;
  }
  const resolved = normalize(join(dirname(entryPath), target));
  return resolved !== ".." && !resolved.startsWith(`..${sep}`) && !isAbsolute(resolved);
}

export async function setTimes(path: string, mtimeMs: number): Promise<void> {
  try {
    await utimes(path, mtimeMs / 1000, mtimeMs / 1000);
  } catch {
    // Some rootless/container filesystems do not permit symlink timestamp
    // updates. Content integrity does not depend on the syscall succeeding.
  }
}

export async function setLinkTimes(path: string, mtimeMs: number): Promise<void> {
  try {
    await lutimes(path, mtimeMs / 1000, mtimeMs / 1000);
  } catch {
    // Symlink timestamps are best effort on filesystems that do not expose
    // lutimes. The manifest still records them for capable restore targets.
  }
}

function entryMetadata(path: string, stat: Stats) {
  return {
    path,
    mode: stat.mode & 0o777,
    uid: stat.uid,
    gid: stat.gid,
    mtime_ns: String(Math.max(0, Math.trunc(stat.mtimeMs * 1_000_000))),
  };
}

function recordEntry(context: ScanContext): void {
  context.counters.files += 1;
  if (context.counters.files > context.mount.maxFiles) {
    throw new Error(`checkpoint mount ${context.mount.name} exceeds maxFiles`);
  }
}

function recordBytes(context: ScanContext, bytes: number): void {
  context.counters.bytes += bytes;
  if (context.counters.bytes > context.mount.maxBytes) {
    throw new Error(`checkpoint mount ${context.mount.name} exceeds maxBytes`);
  }
}

async function scanDirectory(
  context: ScanContext,
  source: string,
  destination: string | null,
  entryPath: string,
  stat: Stats,
  walk: WalkDirectory,
): Promise<void> {
  const common = entryMetadata(entryPath, stat);
  context.entries.push({ ...common, kind: "directory", size: 0 });
  if (destination) await mkdir(destination, { recursive: true, mode: common.mode });
  await walk(source, entryPath);
  if (!destination) return;
  await chmod(destination, common.mode);
  await setTimes(destination, stat.mtimeMs);
}

async function scanFile(
  context: ScanContext,
  source: string,
  destination: string | null,
  entryPath: string,
  stat: Stats,
): Promise<void> {
  recordBytes(context, stat.size);
  const common = entryMetadata(entryPath, stat);
  context.entries.push({
    ...common,
    kind: "file",
    size: stat.size,
    digest: await hashFile(source),
  });
  if (!destination) return;
  await mkdir(resolve(destination, ".."), { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, common.mode);
  await setTimes(destination, stat.mtimeMs);
}

async function scanSymlink(
  context: ScanContext,
  source: string,
  destination: string | null,
  entryPath: string,
  stat: Stats,
): Promise<void> {
  const target = await readlink(source);
  if (!safeSymlinkTarget(entryPath, target)) {
    throw new Error("checkpoint contains an absolute or traversing symlink");
  }
  const size = Buffer.byteLength(target);
  recordBytes(context, size);
  context.entries.push({
    ...entryMetadata(entryPath, stat),
    kind: "symlink",
    size,
    digest: `sha256:${createHash("sha256").update(target).digest("hex")}`,
    link_target: target,
  });
  if (!destination) return;
  await mkdir(resolve(destination, ".."), { recursive: true });
  await symlink(target, destination);
  await setLinkTimes(destination, stat.mtimeMs);
}

async function scanEntry(
  context: ScanContext,
  directory: string,
  relativeDirectory: string,
  name: string,
  walk: WalkDirectory,
): Promise<void> {
  const entryPath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
  if (!safeRelativePath(entryPath)) throw new Error("checkpoint contains an unsafe path");
  const source = join(directory, name);
  const stat = await lstat(source);
  if ((stat.mode & 0o6000) !== 0) {
    throw new Error("checkpoint contains setuid or setgid mode bits");
  }
  recordEntry(context);
  const destination = context.destinationRoot ? join(context.destinationRoot, entryPath) : null;
  if (stat.isDirectory()) {
    await scanDirectory(context, source, destination, entryPath, stat, walk);
    return;
  }
  if (stat.isFile()) {
    await scanFile(context, source, destination, entryPath, stat);
    return;
  }
  if (stat.isSymbolicLink()) {
    await scanSymlink(context, source, destination, entryPath, stat);
    return;
  }
  throw new Error("checkpoint contains a socket, device, FIFO, or unsupported file type");
}

export async function scanMount(
  sourceRoot: string,
  mount: PersistenceMount,
  destinationRoot?: string,
): Promise<{ entries: CheckpointManifest["mounts"][number]["entries"]; counters: ScanCounters }> {
  const entries: CheckpointManifest["mounts"][number]["entries"] = [];
  const counters: ScanCounters = { bytes: 0, files: 0 };
  const context: ScanContext = { entries, counters, mount, destinationRoot };

  const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const child of children) {
      await scanEntry(context, directory, relativeDirectory, child.name, walk);
    }
  };

  await walk(sourceRoot, "");
  return { entries, counters };
}

export async function makeReadOnly(path: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isDirectory()) {
    for (const child of await readdir(path)) await makeReadOnly(join(path, child));
    await chmod(path, 0o500);
  } else if (stat.isFile()) {
    await chmod(path, 0o400);
  }
}

export async function makeWritable(path: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isDirectory()) {
    await chmod(path, 0o700);
    for (const child of await readdir(path)) await makeWritable(join(path, child));
  } else if (stat.isFile()) {
    await chmod(path, 0o600);
  }
}

export async function restoreCheckpointContent(
  checkpointRoot: string,
  target: { root: string; uid?: number; gid?: number },
  manifest: CheckpointManifest,
) {
  for (const mount of manifest.mounts) {
    const destination = join(target.root, mount.name);
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true, mode: 0o700 });
    await safeOwnership(
      destination,
      target.uid ?? process.getuid?.() ?? 1000,
      target.gid ?? process.getgid?.() ?? 1000,
      true,
    );
    const source = join(checkpointRoot, mount.name);
    for (const entry of mount.entries) {
      const from = join(source, entry.path);
      const to = join(destination, entry.path);
      if (entry.kind === "directory") {
        await mkdir(to, { recursive: true, mode: entry.mode });
      } else if (entry.kind === "file") {
        await mkdir(resolve(to, ".."), { recursive: true });
        await copyFile(from, to);
        await chmod(to, entry.mode);
        await chown(to, entry.uid, entry.gid).catch(async () => {
          await chmod(to, entry.mode | 0o006);
        });
        await setTimes(to, Number(BigInt(entry.mtime_ns) / 1_000_000n));
      } else {
        const linkTarget = entry.link_target;
        if (!linkTarget || !safeSymlinkTarget(entry.path, linkTarget)) {
          throw new Error("checkpoint manifest contains an unsafe symlink");
        }
        await mkdir(resolve(to, ".."), { recursive: true });
        await symlink(linkTarget, to);
        await lchown(to, entry.uid, entry.gid).catch(() => {});
        await setLinkTimes(to, Number(BigInt(entry.mtime_ns) / 1_000_000n));
      }
    }
    for (const entry of [...mount.entries].reverse()) {
      if (entry.kind !== "directory") continue;
      const path = join(destination, entry.path);
      let mode = entry.mode;
      await chown(path, entry.uid, entry.gid).catch(() => {
        mode |= 0o007;
      });
      await chmod(path, mode);
      await setTimes(path, Number(BigInt(entry.mtime_ns) / 1_000_000n));
    }
  }
}
