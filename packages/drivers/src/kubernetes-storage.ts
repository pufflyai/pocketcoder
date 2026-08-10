import type { CheckpointManifest, PersistenceMount } from "@pstdio/pocketcoder-contracts";
import type {
  AllocatedStorage,
  CheckpointRef,
  DiscoveredCheckpoint,
  DiscoveredStorage,
  RuntimeMountRef,
  SnapshotResult,
  StorageAllocation,
  StorageRef,
  WorkspaceStorageDriver,
} from "@pstdio/pocketcoder-runtime-core";
import { FilesystemStorageDriver, type FilesystemStorageDriverOptions } from "./filesystem-storage";

export interface KubernetesPvcStorageDriverOptions extends FilesystemStorageDriverOptions {
  workspaceClaimName: string;
  workspaceClaimSubPath?: string;
}

// Checkpoint I/O runs in the server against its mounted PVC, while workspace
// pods receive only a claim + opaque subPath capability. The same persistence
// orchestration therefore works with Docker bind mounts, kind/minikube, and
// multi-node Kubernetes clusters backed by an RWX-capable claim.
export class KubernetesPvcStorageDriver implements WorkspaceStorageDriver {
  readonly kind = "kubernetes-pvc";
  private readonly filesystem: FilesystemStorageDriver;
  private readonly claimName: string;
  private readonly claimSubPath: string;

  constructor(options: KubernetesPvcStorageDriverOptions) {
    if (
      options.workspaceClaimName.length > 253 ||
      !/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(options.workspaceClaimName)
    ) {
      throw new Error("workspaceClaimName must be a Kubernetes resource name");
    }
    this.filesystem = new FilesystemStorageDriver(options);
    this.claimName = options.workspaceClaimName;
    this.claimSubPath = (options.workspaceClaimSubPath ?? "workspaces").replace(/^\/|\/$/g, "");
    if (
      !this.claimSubPath ||
      this.claimSubPath
        .split("/")
        .some((part) => !part || part === "." || part === ".." || !/^[A-Za-z0-9._-]+$/.test(part))
    ) {
      throw new Error("workspaceClaimSubPath must be a normalized relative path");
    }
  }

  async allocate(input: StorageAllocation): Promise<AllocatedStorage> {
    const allocated = await this.filesystem.allocate(input);
    return {
      ref: allocated.ref,
      mounts: await this.runtimeMounts(allocated.ref, input.mounts),
    };
  }

  async runtimeMounts(ref: StorageRef, mounts: PersistenceMount[]): Promise<RuntimeMountRef[]> {
    return mounts.map((mount) => ({
      name: mount.name,
      target: mount.target,
      source: {
        kind: "pvc",
        claimName: this.claimName,
        subPath: [this.claimSubPath, ref.id, mount.name].filter(Boolean).join("/"),
      },
    }));
  }

  async cloneCheckpoint(
    checkpoint: CheckpointRef,
    target: StorageRef,
    manifest: CheckpointManifest,
  ): Promise<void> {
    await this.filesystem.cloneCheckpoint(checkpoint, target, manifest);
  }

  async snapshot(
    storage: StorageRef,
    checkpointId: string,
    templateDigest: string,
    mounts: PersistenceMount[],
  ): Promise<SnapshotResult> {
    return await this.filesystem.snapshot(storage, checkpointId, templateDigest, mounts);
  }

  async verifyCheckpoint(
    ref: CheckpointRef,
    expected: CheckpointManifest,
  ): Promise<CheckpointManifest> {
    return await this.filesystem.verifyCheckpoint(ref, expected);
  }

  async deleteStorage(ref: StorageRef): Promise<void> {
    await this.filesystem.deleteStorage(ref);
  }

  async deleteCheckpoint(ref: CheckpointRef): Promise<void> {
    await this.filesystem.deleteCheckpoint(ref);
  }

  async listStorage(): Promise<DiscoveredStorage[]> {
    return await this.filesystem.listStorage();
  }

  async listCheckpoints(): Promise<DiscoveredCheckpoint[]> {
    return await this.filesystem.listCheckpoints();
  }
}
