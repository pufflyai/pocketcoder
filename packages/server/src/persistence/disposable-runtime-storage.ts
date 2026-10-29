import { randomUUID } from "node:crypto";
import type {
  PersistenceStore,
  RuntimeMountRef,
  StorageRef,
  WorkspaceRow,
  WorkspaceStorageDriver,
} from "@pstdio/pocketcoder-runtime-core";

export async function prepareDisposableRuntimeStorage(
  store: PersistenceStore,
  providerKind: string,
  workspace: WorkspaceRow,
  at: Date,
  shared?: WorkspaceStorageDriver,
) {
  const disposableKind = providerKind === "kubernetes" ? "empty-dir" : "tmpfs";
  const kind = shared?.kind === "kubernetes-shared" ? shared.kind : disposableKind;
  const mounts = workspace.templateSnapshot.spec.persistence.mounts;
  if (mounts.length === 0) return [];
  let storage = await store.getWorkspaceStorage(workspace.id);
  if (!storage) {
    const id = randomUUID();
    storage = await store.insertWorkspaceStorage({
      id,
      workspaceId: workspace.id,
      principalId: workspace.principalId,
      providerKind,
      providerRef: kind === "kubernetes-shared" ? {} : { kind, id },
      state: workspace.restoredFromCheckpointId ? "restoring" : "ready",
      mountManifest: mounts,
      logicalBytes: null,
      fileCount: null,
      retainedUntil: null,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
      lastErrorCode: null,
    });
  }
  if (shared?.kind === "kubernetes-shared") {
    if (storage.state === "deleted") throw new Error("Shared runtime storage is unavailable");
    if (!Object.keys(storage.providerRef).length) {
      const { uid, gid } = workspace.templateSnapshot.spec.security;
      const allocated = await shared.allocate({ storageId: storage.id, workspaceId: workspace.id, mounts, uid, gid });
      await store.updateWorkspaceStorage(storage.id, { providerRef: allocated.ref, providerKind: shared.kind }, at);
      return allocated.mounts;
    }
    return shared.runtimeMounts(storage.providerRef as StorageRef, mounts);
  }
  if (storage.providerRef.kind !== kind || storage.state === "deleted") {
    throw new Error("Disposable runtime storage is unavailable");
  }
  const { uid, gid } = workspace.templateSnapshot.spec.security;
  return mounts.map(
    (mount): RuntimeMountRef => ({
      name: mount.name,
      target: mount.target,
      source:
        disposableKind === "empty-dir"
          ? { kind: disposableKind, maxBytes: mount.maxBytes }
          : { kind: disposableKind, maxBytes: mount.maxBytes, uid, gid },
    }),
  );
}
