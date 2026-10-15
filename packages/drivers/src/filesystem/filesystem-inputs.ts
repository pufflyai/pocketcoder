import { createHash } from "node:crypto";
import { constants, existsSync, realpathSync } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, rmdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { InputObjectReference } from "@pstdio/pocketcoder-contracts";
import type { InputBackingRef, InputStorageDriver } from "@pstdio/pocketcoder-runtime-core";

function physicalPath(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  return join(physicalPath(dirname(path)), basename(path));
}
function contains(parent: string, child: string) {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
async function syncDirectory(path: string) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// This root is private to the controller. Projection drivers must copy from it;
// they must never mount it, its parents, or a writable alias in a workload.
export class FilesystemInputStorage implements InputStorageDriver {
  private readonly root: string;
  private directoryWork: Promise<unknown> = Promise.resolve();
  private readonly active = new Set<string>();
  constructor(root: string, workloadRoots: string[]) {
    if (!isAbsolute(root) || resolve(root) === "/")
      throw new Error("Input root must be an absolute private directory.");
    this.root = physicalPath(resolve(root));
    if (this.root === sep) throw new Error("Input root must be a private directory, not the filesystem root.");
    for (const candidate of workloadRoots) {
      const other = physicalPath(resolve(candidate));
      if (contains(this.root, other) || contains(other, this.root))
        throw new Error("Canonical input storage must not overlap workload storage.");
    }
  }
  private serialize<T>(work: () => Promise<T>) {
    const next = this.directoryWork.then(work, work);
    this.directoryWork = next.catch(() => {});
    return next;
  }
  private directory(ref: InputBackingRef) {
    for (const id of [ref.workspaceId, ref.fileId, ref.versionId])
      if (!UUID.test(id)) throw new Error("Input storage IDs must be UUIDs.");
    return join(this.root, ref.workspaceId, ref.fileId, ref.versionId);
  }
  private async init(ref: InputBackingRef) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const parts = [ref.workspaceId, ref.fileId, ref.versionId];
    let parent = this.root;
    if (!(await lstat(parent)).isDirectory() || (await lstat(parent)).isSymbolicLink())
      throw new Error("Invalid input storage root.");
    for (const part of parts) {
      const child = join(parent, part);
      await mkdir(child, { mode: 0o700 }).catch((e) => {
        if (e.code !== "EEXIST") throw e;
      });
      if (!(await lstat(child)).isDirectory() || (await lstat(child)).isSymbolicLink())
        throw new Error("Invalid input storage directory.");
      await syncDirectory(parent);
      parent = child;
    }
    return parent;
  }
  async create(ref: InputBackingRef) {
    this.directory(ref);
    const key = JSON.stringify(ref);
    this.active.add(key);
    const { directory, handle } = await this.serialize(async () => {
      const directory = await this.init(ref);
      const handle = await open(join(directory, "pending"), "wx", 0o600);
      return { directory, handle };
    }).catch((error) => {
      this.active.delete(key);
      throw error;
    });
    const active = this.active;
    let closed = false;
    return {
      async write(bytes: Uint8Array) {
        await handle.writeFile(bytes);
      },
      async publish() {
        await handle.sync();
        await handle.close();
        closed = true;
        await rename(join(directory, "pending"), join(directory, "payload"));
        await syncDirectory(directory);
        active.delete(key);
      },
      async close() {
        active.delete(key);
        if (!closed) {
          await handle.close();
          closed = true;
        }
      },
    };
  }
  async verify(ref: InputBackingRef, expected: InputObjectReference) {
    const handle = await open(join(this.directory(ref), "payload"), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== expected.sizeBytes || info.nlink !== 1)
        throw new Error("Input bytes are unavailable.");
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      while (position < expected.sizeBytes) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, expected.sizeBytes - position),
          position,
        );
        if (!bytesRead) throw new Error("Input bytes are truncated.");
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      if (`sha256:${hash.digest("hex")}` !== expected.digest)
        throw new Error("Input digest does not match canonical bytes.");
    } finally {
      await handle.close();
    }
  }
  async read(ref: InputBackingRef, expected: InputObjectReference) {
    await this.verify(ref, expected);
    const handle = await open(join(this.directory(ref), "payload"), constants.O_RDONLY | constants.O_NOFOLLOW);
    let position = 0;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (position === expected.sizeBytes) {
            await handle.close();
            controller.close();
            return;
          }
          const bytes = Buffer.alloc(Math.min(64 * 1024, expected.sizeBytes - position));
          const { bytesRead } = await handle.read(bytes, 0, bytes.length, position);
          if (!bytesRead) throw new Error("Canonical input became unavailable during projection.");
          position += bytesRead;
          controller.enqueue(bytes.subarray(0, bytesRead));
        } catch (error) {
          await handle.close();
          controller.error(error);
        }
      },
      async cancel() {
        await handle.close();
      },
    });
  }
  async remove(ref: InputBackingRef) {
    const path = this.directory(ref);
    await rm(path, { recursive: true, force: true });
    await syncDirectory(join(this.root, ref.workspaceId, ref.fileId)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  pruneEmpty(protectedRefs: InputBackingRef[]) {
    return this.serialize(() => this.pruneDirectories(protectedRefs));
  }
  private async pruneDirectories(protectedRefs: InputBackingRef[]) {
    const protectedFiles = new Set(
      [...protectedRefs, ...Array.from(this.active, (key) => JSON.parse(key) as InputBackingRef)].map((ref) =>
        join(this.root, ref.workspaceId, ref.fileId),
      ),
    );
    const directories = async (path: string) =>
      (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory() && UUID.test(entry.name));
    const removeEmpty = async (path: string) => {
      try {
        await rmdir(path);
        await syncDirectory(dirname(path));
      } catch (error) {
        if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    };
    const workspaces = await directories(this.root).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const workspace of workspaces) {
      const root = join(this.root, workspace.name);
      for (const file of await directories(root)) {
        const directory = join(root, file.name);
        if (!protectedFiles.has(directory)) await removeEmpty(directory);
      }
      if (![...protectedFiles].some((path) => dirname(path) === root)) await removeEmpty(root);
    }
  }
  async list() {
    const refs: InputBackingRef[] = [];
    const directories = async (path: string) =>
      (await readdir(path, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && UUID.test(e.name))
        .map((e) => e.name);
    try {
      await lstat(this.root);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return refs;
      throw e;
    }
    for (const workspaceId of await directories(this.root))
      for (const fileId of await directories(join(this.root, workspaceId)))
        for (const versionId of await directories(join(this.root, workspaceId, fileId)))
          refs.push({ workspaceId, fileId, versionId });
    return refs;
  }
}
