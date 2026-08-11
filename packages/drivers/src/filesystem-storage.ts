import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type CheckpointManifest,
  CheckpointManifestSchema,
  canonicalJson,
  digestOf,
  type PersistenceMount,
} from "@pstdio/pocketcoder-contracts";
import type {
  AllocatedStorage,
  CheckpointRef,
  RuntimeMountRef,
  SnapshotResult,
  StorageAllocation,
  StorageRef,
  WorkspaceStorageDriver,
} from "@pstdio/pocketcoder-runtime-core";
import {
  makeReadOnly,
  makeWritable,
  restoreCheckpointContent,
  safeOwnership,
  scanMount,
} from "./filesystem-checkpoint";
import {
  CHECKPOINT_METADATA_FILE,
  deleteCheckpointRoot,
  deleteStorageRoot,
  discoverCheckpoints,
  discoverStorage,
  STORAGE_METADATA_FILE,
} from "./filesystem-inventory";

interface FilesystemRef extends StorageRef {
  kind: "filesystem";
  root: string;
  uid?: number;
  gid?: number;
}

interface StorageMetadata {
  format: "pocketcoder-storage/v1";
  storage_id: string;
  workspace_id: string;
}

interface CheckpointMetadata {
  format: "pocketcoder-checkpoint-metadata/v1";
  checkpoint_id: string;
  manifest_digest: string;
}

const MANIFEST_FILE = "manifest.json";

export interface FilesystemStorageDriverOptions {
  workspaceRoot: string;
  checkpointRoot: string;
}

function assertSafeRoot(value: string, name: string): string {
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  const normalized = resolve(value);
  if (normalized === resolve(sep)) throw new Error(`${name} must not be the filesystem root`);
  if (normalized === resolve(process.cwd())) {
    throw new Error(`${name} must not be the PocketCoder process working directory`);
  }
  return normalized;
}

function filesystemRef(value: StorageRef | CheckpointRef): FilesystemRef {
  if (value.kind !== "filesystem" || typeof value.root !== "string" || !isAbsolute(value.root)) {
    throw new Error("invalid filesystem storage reference");
  }
  return value as FilesystemRef;
}

function childOf(root: string, id: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("storage IDs must be UUIDs");
  const child = resolve(root, id);
  if (relative(root, child).startsWith("..")) throw new Error("storage path escaped its root");
  return child;
}

export class FilesystemStorageDriver implements WorkspaceStorageDriver {
  readonly kind = "filesystem";
  private readonly workspaceRoot: string;
  private readonly checkpointRoot: string;

  constructor(options: FilesystemStorageDriverOptions) {
    this.workspaceRoot = assertSafeRoot(options.workspaceRoot, "workspaceRoot");
    this.checkpointRoot = assertSafeRoot(options.checkpointRoot, "checkpointRoot");
    if (this.workspaceRoot === this.checkpointRoot) {
      throw new Error("workspaceRoot and checkpointRoot must be different");
    }
    if (
      !relative(this.workspaceRoot, this.checkpointRoot).startsWith("..") ||
      !relative(this.checkpointRoot, this.workspaceRoot).startsWith("..")
    ) {
      throw new Error("workspaceRoot and checkpointRoot must not overlap");
    }
  }

  private async initRoots(): Promise<void> {
    // NFS root squashing makes kubelet traverse as an anonymous user while it
    // resolves a subPath. Execute-only parents reveal no sibling names.
    await mkdir(this.workspaceRoot, { recursive: true, mode: 0o711 });
    await mkdir(this.checkpointRoot, { recursive: true, mode: 0o700 });
    await chmod(this.workspaceRoot, 0o711);
    await chmod(this.checkpointRoot, 0o700);
  }

  private storageRef(ref: StorageRef): FilesystemRef {
    const storage = filesystemRef(ref);
    if (storage.root !== childOf(this.workspaceRoot, storage.id)) {
      throw new Error("storage reference does not match its opaque allocation");
    }
    return storage;
  }

  private checkpointRef(ref: CheckpointRef): FilesystemRef {
    const checkpoint = filesystemRef(ref);
    if (checkpoint.root !== childOf(this.checkpointRoot, checkpoint.id)) {
      throw new Error("checkpoint reference does not match its opaque allocation");
    }
    return checkpoint;
  }

  async allocate(input: StorageAllocation): Promise<AllocatedStorage> {
    await this.initRoots();
    const root = childOf(this.workspaceRoot, input.storageId);
    await mkdir(root, { recursive: true, mode: 0o711 });
    await chmod(root, 0o711);
    for (const mount of input.mounts) {
      const path = join(root, mount.name);
      await mkdir(path, { recursive: true, mode: 0o770 });
      await safeOwnership(path, input.uid, input.gid, true);
    }
    const metadata: StorageMetadata = {
      format: "pocketcoder-storage/v1",
      storage_id: input.storageId,
      workspace_id: input.workspaceId,
    };
    await writeFile(join(root, STORAGE_METADATA_FILE), canonicalJson(metadata), { mode: 0o600 });
    const ref: FilesystemRef = {
      kind: "filesystem",
      id: input.storageId,
      root,
      uid: input.uid,
      gid: input.gid,
    };
    return { ref, mounts: await this.runtimeMounts(ref, input.mounts) };
  }

  async runtimeMounts(ref: StorageRef, mounts: PersistenceMount[]): Promise<RuntimeMountRef[]> {
    const storage = this.storageRef(ref);
    return mounts.map((mount) => ({
      name: mount.name,
      target: mount.target,
      source: { kind: "host-path", path: join(storage.root, mount.name) },
    }));
  }

  async snapshot(
    ref: StorageRef,
    checkpointId: string,
    templateDigest: string,
    mounts: PersistenceMount[],
  ): Promise<SnapshotResult> {
    await this.initRoots();
    const storage = this.storageRef(ref);
    const finalRoot = childOf(this.checkpointRoot, checkpointId);
    try {
      const manifest = CheckpointManifestSchema.parse(
        JSON.parse(await readFile(join(finalRoot, MANIFEST_FILE), "utf8")),
      );
      const manifestDigest = digestOf(manifest);
      return {
        ref: { kind: "filesystem", id: checkpointId, root: finalRoot },
        manifest,
        manifestDigest,
        storedBytes: manifest.logical_bytes,
      };
    } catch (error) {
      let finalExists = false;
      try {
        await lstat(finalRoot);
        finalExists = true;
      } catch {
        // Missing is the only case in which creation is allowed.
      }
      if (finalExists) {
        throw new Error("existing checkpoint content is invalid", {
          cause: error,
        });
      }
    }
    const temporaryRoot = join(this.checkpointRoot, `.creating-${checkpointId}`);
    await makeWritable(temporaryRoot).catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    try {
      const manifestMounts: CheckpointManifest["mounts"] = [];
      let logicalBytes = 0;
      let fileCount = 0;
      for (const mount of mounts) {
        const source = join(storage.root, mount.name);
        const destination = join(temporaryRoot, mount.name);
        await mkdir(destination, { recursive: true, mode: 0o700 });
        const scanned = await scanMount(source, mount, destination);
        manifestMounts.push({ name: mount.name, entries: scanned.entries });
        logicalBytes += scanned.counters.bytes;
        fileCount += scanned.counters.files;
      }
      const manifest: CheckpointManifest = {
        format: "pocketcoder-checkpoint/v1",
        checkpoint_id: checkpointId,
        template_digest: templateDigest,
        mounts: manifestMounts,
        logical_bytes: logicalBytes,
        file_count: fileCount,
      };
      const manifestDigest = digestOf(manifest);
      const metadata: CheckpointMetadata = {
        format: "pocketcoder-checkpoint-metadata/v1",
        checkpoint_id: checkpointId,
        manifest_digest: manifestDigest,
      };
      await writeFile(join(temporaryRoot, MANIFEST_FILE), canonicalJson(manifest), {
        mode: 0o600,
      });
      await writeFile(join(temporaryRoot, CHECKPOINT_METADATA_FILE), canonicalJson(metadata), {
        mode: 0o600,
      });
      await makeReadOnly(temporaryRoot);
      await rename(temporaryRoot, finalRoot);
      return {
        ref: { kind: "filesystem", id: checkpointId, root: finalRoot },
        manifest,
        manifestDigest,
        storedBytes: logicalBytes,
      };
    } catch (error) {
      await makeWritable(temporaryRoot).catch(() => {});
      await rm(temporaryRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async verifyCheckpoint(
    ref: CheckpointRef,
    expected: CheckpointManifest,
  ): Promise<CheckpointManifest> {
    const checkpoint = this.checkpointRef(ref);
    const diskManifest = CheckpointManifestSchema.parse(
      JSON.parse(await readFile(join(checkpoint.root, MANIFEST_FILE), "utf8")),
    );
    if (digestOf(diskManifest) !== digestOf(expected)) {
      throw new Error("checkpoint manifest digest mismatch");
    }
    const contentProjection = (entries: CheckpointManifest["mounts"][number]["entries"]) =>
      entries.map((entry) => ({
        path: entry.path,
        kind: entry.kind,
        size: entry.size,
        digest: entry.digest,
        link_target: entry.link_target,
      }));
    let logicalBytes = 0;
    let fileCount = 0;
    for (const expectedMount of expected.mounts) {
      const maxBytes = expectedMount.entries.reduce((sum, entry) => sum + entry.size, 0);
      const scanned = await scanMount(join(checkpoint.root, expectedMount.name), {
        name: expectedMount.name,
        target: "/verification",
        maxBytes: Math.max(1, maxBytes),
        maxFiles: Math.max(1, expectedMount.entries.length),
      });
      if (
        canonicalJson(contentProjection(scanned.entries)) !==
        canonicalJson(contentProjection(expectedMount.entries))
      ) {
        throw new Error("checkpoint content digest mismatch");
      }
      logicalBytes += scanned.counters.bytes;
      fileCount += scanned.counters.files;
    }
    if (logicalBytes !== expected.logical_bytes || fileCount !== expected.file_count) {
      throw new Error("checkpoint content digest mismatch");
    }
    return expected;
  }

  async cloneCheckpoint(
    checkpointRef: CheckpointRef,
    targetRef: StorageRef,
    manifest: CheckpointManifest,
  ): Promise<void> {
    await this.verifyCheckpoint(checkpointRef, manifest);
    const checkpoint = this.checkpointRef(checkpointRef);
    const target = this.storageRef(targetRef);
    await restoreCheckpointContent(checkpoint.root, target, manifest);
  }

  async deleteStorage(ref: StorageRef): Promise<void> {
    const storage = this.storageRef(ref);
    await deleteStorageRoot(storage.root);
  }

  async deleteCheckpoint(ref: CheckpointRef): Promise<void> {
    const checkpoint = this.checkpointRef(ref);
    await deleteCheckpointRoot(checkpoint.root);
  }

  async listStorage() {
    await this.initRoots();
    return discoverStorage(this.workspaceRoot);
  }

  async listCheckpoints() {
    await this.initRoots();
    return discoverCheckpoints(this.checkpointRoot);
  }
}
