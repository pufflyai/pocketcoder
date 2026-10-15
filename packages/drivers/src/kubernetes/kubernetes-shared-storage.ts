import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { type CheckpointManifest, canonicalJson, type PersistenceMount } from "@pstdio/pocketcoder-contracts";
import type {
  CheckpointRef,
  InputProjectionRef,
  InputStorageDriver,
  RuntimeMountRef,
  StorageAllocation,
  StorageRef,
  WorkspaceStorageDriver,
} from "@pstdio/pocketcoder-runtime-core";
import { FilesystemInputPublisher, syncDirectory } from "../filesystem/filesystem-projections";
import { FilesystemStorageDriver } from "../filesystem/filesystem-storage";
import { type KubernetesSharedStorageOptions, validateSharedProfile } from "./kubernetes-shared-profile";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function allocationId(id: string) {
  if (!UUID.test(id)) throw new Error("Shared allocation IDs must be UUIDs");
  return id;
}
async function durableFile(path: string, bytes: string) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
function counters(mounts: PersistenceMount[]) {
  return mounts.reduce((sum, mount) => ({ bytes: sum.bytes + mount.maxBytes, files: sum.files + mount.maxFiles }), {
    bytes: 0,
    files: 0,
  });
}

// The single controller coordinator owns the PVC root. Only confined child
// directories enter workloads; staging and publisher authority stay outside.
export class KubernetesSharedStorage implements WorkspaceStorageDriver {
  readonly kind = "kubernetes-shared";
  private readonly filesystem: FilesystemStorageDriver;
  private readonly staging: FilesystemStorageDriver;
  private readonly publisher: FilesystemInputPublisher;
  private work: Promise<unknown> = Promise.resolve();
  constructor(readonly options: KubernetesSharedStorageOptions) {
    validateSharedProfile(options);
    this.filesystem = new FilesystemStorageDriver({
      workspaceRoot: join(options.root, "workspaces"),
      checkpointRoot: options.checkpointRoot,
    });
    this.staging = new FilesystemStorageDriver({
      workspaceRoot: join(options.root, "pending"),
      checkpointRoot: options.checkpointRoot,
    });
    this.publisher = new FilesystemInputPublisher(
      join(options.root, "inputs"),
      {
        maxBytes: options.maxBytes,
        maxFiles: options.maxFiles,
      },
      () => this.reserved(),
    );
  }
  private serialize<T>(work: () => Promise<T>) {
    const next = this.work.then(work);
    this.work = next.catch(() => {});
    return next;
  }
  private path(ref: StorageRef) {
    if (ref.kind !== this.kind) throw new Error("Invalid shared storage reference");
    return join(this.options.root, "workspaces", allocationId(ref.id));
  }
  private local(ref: StorageRef) {
    return { ...ref, kind: "filesystem", root: this.path(ref) };
  }
  private async record(ref: StorageRef): Promise<StorageAllocation> {
    const root = ref.staged ? join(this.options.root, "pending", allocationId(ref.id)) : this.path(ref);
    return JSON.parse(await readFile(join(root, ".allocation.json"), "utf8"));
  }
  private async reserved() {
    let bytes = 0;
    let files = 0;
    for (const row of await this.listStorage()) {
      const used = counters((await this.record(row.ref)).mounts);
      bytes += used.bytes;
      files += used.files;
    }
    return { bytes, files };
  }
  allocate(input: StorageAllocation) {
    return this.serialize(() => this.allocateOne(input));
  }
  private async allocateOne(input: StorageAllocation) {
    allocationId(input.storageId);
    allocationId(input.workspaceId);
    if (input.mounts.some((mount) => mount.name === "inputs" || !/^[a-z][a-z0-9-]*$/.test(mount.name)))
      throw new Error("Shared allocation requires confined mount names");
    const published = (await this.filesystem.listStorage()).find((row) => row.storageId === input.storageId);
    if (published) {
      const ref = { ...published.ref, kind: this.kind };
      const original = await this.record(ref);
      if (canonicalJson(original) !== canonicalJson(input)) throw new Error("Shared allocation identity changed");
      const restored = { ...ref, uid: original.uid, gid: original.gid };
      return { ref: restored, mounts: await this.runtimeMounts(restored, input.mounts) };
    }
    // Staging has never been mounted. Only its retrying owner may reclaim it.
    await rm(join(this.options.root, "pending", input.storageId), { recursive: true, force: true });
    const reserved = await this.reserved();
    const projected = await this.publisher.usage();
    const requested = counters(input.mounts);
    if (
      reserved.bytes + projected.bytes + requested.bytes > this.options.maxBytes ||
      reserved.files + projected.files + requested.files > this.options.maxFiles
    )
      throw new Error("Shared allocation exceeds configured bounds or owned capacity");
    const staged = await this.staging.allocate(input);
    const root = staged.ref.root as string;
    await durableFile(join(root, ".allocation.json"), JSON.stringify(input));
    if (input.retainForExtraction) await durableFile(join(root, ".extraction-pending"), "");
    const metadata = await open(join(root, ".pocketcoder-storage.json"), "r");
    try {
      await metadata.sync();
    } finally {
      await metadata.close();
    }
    await syncDirectory(root);
    const destination = join(this.options.root, "workspaces", input.storageId);
    await rename(root, destination);
    await syncDirectory(join(this.options.root, "workspaces"));
    await syncDirectory(join(this.options.root, "pending"));
    const ref = { ...staged.ref, root: destination, kind: this.kind, uid: input.uid, gid: input.gid };
    return { ref, mounts: await this.runtimeMounts(ref, input.mounts) };
  }
  async runtimeMounts(ref: StorageRef, mounts: PersistenceMount[]): Promise<RuntimeMountRef[]> {
    const stored = await this.record(ref);
    if (ref.staged || canonicalJson(stored.mounts) !== canonicalJson(mounts))
      throw new Error("Shared allocation manifest changed");
    return mounts.map((mount) => ({
      name: mount.name,
      target: mount.target,
      source: { kind: "shared-filesystem", allocationId: ref.id, directory: mount.name },
    }));
  }
  async resolveMount(workspaceId: string, mount: RuntimeMountRef) {
    if (mount.source.kind !== "shared-filesystem") throw new Error("Invalid shared mount");
    const source = mount.source;
    const root = join(this.options.root, "workspaces", allocationId(source.allocationId));
    const record = await this.record({ kind: this.kind, id: source.allocationId });
    if (record.workspaceId !== workspaceId) throw new Error("Shared allocation belongs to another workspace");
    const owned = record.mounts.find((item) => item.name === source.directory && item.target === mount.target);
    if (!owned) throw new Error("Shared subdirectory is not allocated");
    const stat = await lstat(join(root, owned.name));
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Shared subdirectory is unavailable");
    return { claimName: this.options.claimName, subPath: `workspaces/${source.allocationId}/${owned.name}` };
  }
  async completeExtraction(ref: StorageRef) {
    await rm(join(this.path(ref), ".extraction-pending"), { force: true });
    await syncDirectory(this.path(ref));
  }
  async inputMount(workspaceId: string): Promise<RuntimeMountRef> {
    await this.publisher.prepare(workspaceId);
    return {
      name: "immutable-inputs",
      target: "/inputs",
      readOnly: true,
      source: { kind: "shared-filesystem", allocationId: workspaceId, directory: "inputs" },
    };
  }
  publishInputs(projection: InputProjectionRef, source: InputStorageDriver) {
    return this.serialize(() => this.publisher.publish(projection, source));
  }
  purgeInputs(workspaceId: string) {
    return this.serialize(() => this.publisher.remove(workspaceId));
  }
  async resolveInput(workspaceId: string, mount: RuntimeMountRef) {
    if (
      mount.source.kind !== "shared-filesystem" ||
      mount.source.directory !== "inputs" ||
      mount.source.allocationId !== workspaceId ||
      mount.target !== "/inputs" ||
      mount.readOnly !== true
    )
      throw new Error("Immutable inputs require their own read-only allocation");
    await this.publisher.prepare(workspaceId);
    return { claimName: this.options.claimName, subPath: `inputs/${allocationId(workspaceId)}/published` };
  }
  deleteStorage(ref: StorageRef) {
    return this.serialize(() => this.deleteAllocation(ref));
  }
  private async deleteAllocation(ref: StorageRef) {
    const pending = await lstat(join(this.path(ref), ".extraction-pending")).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (pending) throw new Error("Managed output extraction is pending");
    await this.filesystem.deleteStorage(this.local(ref));
    await rm(join(this.options.root, "pending", ref.id), { recursive: true, force: true });
    await syncDirectory(join(this.options.root, "workspaces"));
    await syncDirectory(join(this.options.root, "pending"));
  }
  async listStorage() {
    const published = await this.filesystem.listStorage();
    const pending = (await this.staging.listStorage()).filter(
      (item) => !published.some((row) => row.storageId === item.storageId),
    );
    return [...published, ...pending.map((item) => ({ ...item, ref: { ...item.ref, staged: true } }))].map((item) => ({
      ...item,
      ref: { ...item.ref, kind: this.kind },
    }));
  }
  snapshot(ref: StorageRef, id: string, digest: string, mounts: PersistenceMount[]) {
    return this.filesystem.snapshot(this.local(ref), id, digest, mounts);
  }
  cloneCheckpoint(checkpoint: CheckpointRef, ref: StorageRef, manifest: CheckpointManifest) {
    return this.filesystem.cloneCheckpoint(checkpoint, this.local(ref), manifest);
  }
  verifyCheckpoint(ref: CheckpointRef, manifest: CheckpointManifest) {
    return this.filesystem.verifyCheckpoint(ref, manifest);
  }
  deleteCheckpoint(ref: CheckpointRef) {
    return this.filesystem.deleteCheckpoint(ref);
  }
  listCheckpoints() {
    return this.filesystem.listCheckpoints();
  }
}
