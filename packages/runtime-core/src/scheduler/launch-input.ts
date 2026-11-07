import type { ProviderInput } from "@pstdio/pocketcoder-contracts";
import type { WorkspaceRow } from "../types";

export function launchInput(row: WorkspaceRow, serverUrl: string, secret: string): ProviderInput {
  return {
    workspace_id: row.id,
    server_url: serverUrl,
    registration_secret: secret,
    template_digest: row.templateDigest,
    template_name: row.templateName,
    template_version: row.templateVersion,
    launch_mode: row.launchMode,
    ...(row.sourceDescriptor ? { source: row.sourceDescriptor } : {}),
    ...(row.restoredFromCheckpointId && row.originWorkspaceId
      ? {
          restore: {
            checkpoint_id: row.restoredFromCheckpointId,
            origin_workspace_id: row.originWorkspaceId,
          },
        }
      : {}),
    ...(row.launchInput ? { launch_input: row.launchInput } : {}),
  };
}
