import type { WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";

// The runtime owns source-only bytes, so a controller needs no shared volume.
// The configured controller archive runtime handles checkpoint restores.
export function disposableSourceRuntime(provider: "docker" | "kubernetes") {
  return {
    async prepareStorage(workspace: WorkspaceRow) {
      const mounts = workspace.templateSnapshot.spec.persistence.mounts;
      if (!mounts.length) return [];
      if (workspace.launchMode !== "create" || !workspace.sourceDescriptor)
        throw new Error("Disposable storage requires a new source workspace.");
      return mounts.map((mount) => ({
        name: mount.name,
        target: mount.target,
        source:
          provider === "docker"
            ? {
                kind: "tmpfs" as const,
                maxBytes: mount.maxBytes,
                uid: workspace.templateSnapshot.spec.security.uid,
                gid: workspace.templateSnapshot.spec.security.gid,
              }
            : { kind: "empty-dir" as const, maxBytes: mount.maxBytes },
      }));
    },
    async cleanupWorkspace() {},
  };
}
