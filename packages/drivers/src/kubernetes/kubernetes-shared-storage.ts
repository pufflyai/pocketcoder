import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CheckpointManifest, PersistenceMount } from "@pstdio/pocketcoder-contracts";
import type {
  CheckpointRef, RuntimeMountRef, StorageAllocation, StorageRef, WorkspaceStorageDriver,
} from "@pstdio/pocketcoder-runtime-core";
import { FilesystemStorageDriver } from "../filesystem/filesystem-storage";
import { type KubernetesSharedStorageOptions, validateSharedProfile } from "./kubernetes-shared-profile";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function allocationId(id: string) {
  if (!UUID.test(id)) throw new Error("Shared allocation IDs must be UUIDs");
  return id;
}

// The controller mounts the PVC root here. Only confined child directories are
// projected into workloads; neither this root nor publisher authority is exposed.
export class KubernetesSharedStorage implements WorkspaceStorageDriver {
  readonly kind = "kubernetes-shared";
  private readonly filesystem: FilesystemStorageDriver;
  constructor(readonly options: KubernetesSharedStorageOptions) {
    validateSharedProfile(options);
    this.filesystem = new FilesystemStorageDriver({
      workspaceRoot: join(options.root, "workspaces"), checkpointRoot: options.checkpointRoot,
    });
  }
  private path(ref: StorageRef) {
    if (ref.kind !== this.kind) throw new Error("Invalid shared storage reference");
    return join(this.options.root, "workspaces", allocationId(ref.id));
  }
  private local(ref: StorageRef) {
    return { ...ref, kind: "filesystem", root: this.path(ref) };
  }
  async allocate(input: StorageAllocation) {
    allocationId(input.storageId);
    allocationId(input.workspaceId);
    if (
      input.mounts.some((mount) => !/^[a-z][a-z0-9-]*$/.test(mount.name)) ||
      input.mounts.reduce((sum, mount) => sum + mount.maxBytes, 0) > this.options.maxBytes ||
      input.mounts.reduce((sum, mount) => sum + mount.maxFiles, 0) > this.options.maxFiles
    ) throw new Error("Shared allocation exceeds configured bounds");
    const allocated = await this.filesystem.allocate(input);
    const root = allocated.ref.root as string;
    await writeFile(join(root, ".mounts.json"), JSON.stringify(input.mounts), { mode: 0o600 });
    // This survives a controller crash and prevents scheduler cleanup from
    // treating pod deletion as successful result extraction.
    await writeFile(join(root, ".extraction-pending"), "", { flag: "a", mode: 0o600 });
    const ref = { ...allocated.ref, kind: this.kind };
    return { ref, mounts: await this.runtimeMounts(ref, input.mounts) };
  }
  async runtimeMounts(ref: StorageRef, mounts: PersistenceMount[]): Promise<RuntimeMountRef[]> {
    const root = this.path(ref);
    const stored = JSON.parse(await readFile(join(root, ".mounts.json"), "utf8"));
    if (JSON.stringify(stored) !== JSON.stringify(mounts)) throw new Error("Shared allocation manifest changed");
    return mounts.map((mount) => ({
      name: mount.name, target: mount.target,
      source: { kind: "shared-filesystem", allocationId: ref.id, directory: mount.name },
    }));
  }
  async resolveMount(workspaceId: string, mount: RuntimeMountRef) {
    if (mount.source.kind !== "shared-filesystem") throw new Error("Invalid shared mount");
    const id = allocationId(mount.source.allocationId);
    const root = join(this.options.root, "workspaces", id);
    const metadata = JSON.parse(await readFile(join(root, ".pocketcoder-storage.json"), "utf8"));
    if (metadata.workspace_id !== workspaceId) throw new Error("Shared allocation belongs to another workspace");
    const mounts: PersistenceMount[] = JSON.parse(await readFile(join(root, ".mounts.json"), "utf8"));
    const owned = mounts.find((item) => item.name === mount.source.directory && item.target === mount.target);
    if (!owned) throw new Error("Shared subdirectory is not allocated");
    const path = join(root, owned.name);
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Shared subdirectory is unavailable");
    return { claimName: this.options.claimName, subPath: `workspaces/${id}/${owned.name}` };
  }
  async completeExtraction(ref: StorageRef) {
    await rm(join(this.path(ref), ".extraction-pending"), { force: true });
  }
  async deleteStorage(ref: StorageRef) {
    const pending = await lstat(join(this.path(ref), ".extraction-pending")).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (pending) throw new Error("Managed output extraction is pending");
    await this.filesystem.deleteStorage(this.local(ref));
  }
  async listStorage() {
    return (await this.filesystem.listStorage()).map((item) => ({ ...item, ref: { ...item.ref, kind: this.kind } }));
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
  deleteCheckpoint(ref: CheckpointRef) { return this.filesystem.deleteCheckpoint(ref); }
  listCheckpoints() { return this.filesystem.listCheckpoints(); }
}
