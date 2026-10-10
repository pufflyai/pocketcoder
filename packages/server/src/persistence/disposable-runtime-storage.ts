import { randomUUID } from "node:crypto";
import type { PersistenceStore, RuntimeMountRef, WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";

export async function prepareDisposableRuntimeStorage(
  store: PersistenceStore,
  providerKind: string,
  workspace: WorkspaceRow,
  at: Date,
) {
  const kind = providerKind === "kubernetes" ? "empty-dir" : "tmpfs";
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
      providerRef: { kind, id },
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
  if (storage.providerRef.kind !== kind || storage.state === "deleted") {
    throw new Error("Disposable runtime storage is unavailable");
  }
  const { uid, gid } = workspace.templateSnapshot.spec.security;
  return mounts.map(
    (mount): RuntimeMountRef => ({
      name: mount.name,
      target: mount.target,
      source: kind === "empty-dir" ? { kind, maxBytes: mount.maxBytes } : { kind, maxBytes: mount.maxBytes, uid, gid },
    }),
  );
}
