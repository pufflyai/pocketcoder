import type { WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";

// Provider refs carry the authored manifest so inspection can measure the installed workload against it.
export function workloadReference(workspace: WorkspaceRow) {
  const manifest = workspace.templateSnapshot.manifest;
  if (!manifest) return {};
  return {
    workloadTemplate: {
      format: manifest.apiVersion,
      name: workspace.templateName,
      version: workspace.templateVersion,
      digest: workspace.templateDigest,
      manifest,
    },
    workspaceId: workspace.id,
  };
}
