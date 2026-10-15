import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { AcceptedInputManifestSchema, canonicalJson } from "@pstdio/pocketcoder-contracts";
import type { InputProjectionRef, InputStorageDriver } from "@pstdio/pocketcoder-runtime-core";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function projectionId(id: string) {
  if (!UUID.test(id)) throw new Error("Projection IDs must be UUIDs");
  return id;
}
export async function syncDirectory(path: string) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function directory(path: string, mode: number) {
  await mkdir(path, { mode, recursive: true });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid publisher directory");
}
async function projectedUsage(root: string) {
  let bytes = 0;
  let files = 0;
  let manifests = 0;
  const workspaces = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return [];
  });
  for (const workspace of workspaces) {
    if (!workspace.isDirectory() || !UUID.test(workspace.name)) throw new Error("Invalid projection inventory");
    for (const tree of ["published", "pending"]) {
      const published = join(root, workspace.name, tree);
      const executions = await readdir(published).catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return [];
      });
      for (const execution of executions) {
        projectionId(execution);
        manifests++;
        const used = await executionUsage(join(published, execution));
        bytes += used.bytes;
        files += used.files;
      }
    }
  }
  return { bytes, files, manifests };
}
async function executionUsage(path: string) {
  let bytes = 0;
  let files = 0;
  for (const file of await readdir(path)) {
    if (file === "manifest.json") continue;
    projectionId(file);
    const info = await lstat(join(path, file));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Invalid projected object");
    bytes += info.size;
    files++;
  }
  return { bytes, files };
}

// The single controller coordinator owns this tree. Workloads only see the
// published child through a read-only mount; private staging is never mounted.
export class FilesystemInputPublisher {
  private work: Promise<unknown> = Promise.resolve();
  constructor(
    readonly root: string,
    readonly bounds: { maxBytes: number; maxFiles: number },
    private readonly reserved?: () => Promise<{ bytes: number; files: number }>,
  ) {
    if (!isAbsolute(root) || resolve(root) === "/") throw new Error("Publisher root must be private and absolute");
    if (Object.values(bounds).some((value) => !Number.isSafeInteger(value) || value <= 0))
      throw new Error("Publisher requires explicit bounds");
  }
  async prepare(workspaceId: string) {
    const root = join(this.root, projectionId(workspaceId));
    await directory(this.root, 0o711);
    await directory(root, 0o711);
    await directory(join(root, "published"), 0o755);
    await directory(join(root, "pending"), 0o700);
    await syncDirectory(root);
    await syncDirectory(this.root);
    return join(root, "published");
  }
  publish(projection: InputProjectionRef, source: InputStorageDriver) {
    const next = this.work.then(() => this.publishOne(projection, source));
    this.work = next.catch(() => {});
    return next;
  }
  usage() {
    return projectedUsage(this.root);
  }
  private async copyObject(
    object: InputProjectionRef["objects"][number],
    source: InputStorageDriver,
    temporary: string,
  ) {
    const reader = (await source.read(object.backing, object.reference)).getReader();
    const handle = await open(join(temporary, projectionId(object.reference.fileId)), "wx", 0o444);
    const hash = createHash("sha256");
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > object.reference.sizeBytes) throw new Error("Input projection exceeds declared bytes");
        hash.update(value);
        await handle.writeFile(value);
      }
      if (size !== object.reference.sizeBytes || `sha256:${hash.digest("hex")}` !== object.reference.digest)
        throw new Error("Input projection digest mismatch");
      await handle.sync();
    } finally {
      await reader.cancel();
      reader.releaseLock();
      await handle.close();
    }
  }
  private async publishOne(projection: InputProjectionRef, source: InputStorageDriver) {
    const manifest = AcceptedInputManifestSchema.parse(projection.manifest);
    const id = projectionId(projection.manifestId);
    if (
      manifest.objects.length > this.bounds.maxFiles ||
      manifest.objects.reduce((sum, file) => sum + file.sizeBytes, 0) > this.bounds.maxBytes ||
      canonicalJson(projection.objects.map((object) => object.reference)) !== canonicalJson(manifest.objects)
    )
      throw new Error("Input projection exceeds its bounds or differs from its frozen manifest");
    const published = await this.prepare(manifest.workspaceId);
    const destination = join(published, id);
    const encoded = canonicalJson(manifest);
    const existing = await readFile(join(destination, "manifest.json"), "utf8").catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (existing !== undefined) {
      if (existing !== encoded) throw new Error("Published input manifest cannot be replaced");
      for (const object of manifest.objects) {
        const bytes = await readFile(join(destination, object.fileId));
        if (
          bytes.length !== object.sizeBytes ||
          `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== object.digest
        )
          throw new Error("Published input bytes are unavailable");
      }
      return destination;
    }
    const temporary = join(this.root, manifest.workspaceId, "pending", id);
    await rm(temporary, { recursive: true, force: true });
    const used = await this.usage();
    const reserved = (await this.reserved?.()) ?? { bytes: 0, files: 0 };
    if (
      used.files + reserved.files + manifest.objects.length > this.bounds.maxFiles ||
      used.manifests + 1 > this.bounds.maxFiles ||
      used.bytes + reserved.bytes + manifest.objects.reduce((sum, object) => sum + object.sizeBytes, 0) >
        this.bounds.maxBytes
    )
      throw new Error("Shared input projection capacity is owned by existing executions");
    await mkdir(temporary, { mode: 0o755 });
    try {
      for (const object of projection.objects) {
        if (object.backing.workspaceId !== manifest.workspaceId || object.backing.fileId !== object.reference.fileId)
          throw new Error("Input backing belongs to another object");
        await this.copyObject(object, source, temporary);
      }
      const handle = await open(join(temporary, "manifest.json"), "wx", 0o444);
      try {
        await handle.writeFile(encoded);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(temporary);
      await rename(temporary, destination);
      await syncDirectory(published);
      await syncDirectory(dirname(temporary));
      return destination;
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }
  async remove(workspaceId: string) {
    await rm(join(this.root, projectionId(workspaceId)), { recursive: true, force: true });
    await syncDirectory(this.root).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
