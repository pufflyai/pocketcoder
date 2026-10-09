import type { WorkspaceRow, WorkspaceTransferRuntime } from "@pstdio/pocketcoder-runtime-core";

// A source-only Kubernetes launch owns disposable bytes through its Job.
// Checkpoint restore remains unavailable until the cross-node slice is delivered.
export function kubernetesSourceRuntime(): WorkspaceTransferRuntime {
  return {
    async prepareStorage(workspace: WorkspaceRow) {
      const mounts = workspace.templateSnapshot.spec.persistence.mounts;
      if (!mounts.length) return [];
      if (workspace.launchMode !== "create" || !workspace.sourceDescriptor)
        throw new Error("Kubernetes disposable storage requires a new source workspace.");
      return mounts.map((mount) => ({
        name: mount.name,
        target: mount.target,
        source: { kind: "empty-dir" as const, maxBytes: mount.maxBytes },
      }));
    },
    async cleanupWorkspace() {},
  };
}
