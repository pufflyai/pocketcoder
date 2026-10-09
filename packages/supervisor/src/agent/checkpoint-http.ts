import type { CheckpointUpload, RestoreTransferSpec } from "@pstdio/pocketcoder-contracts";

export interface TransferConnection {
  workspaceId: string;
  connectionId: string;
  epoch: number;
}

export function checkpointRequest(
  serverUrl: string,
  grant: CheckpointUpload | RestoreTransferSpec,
  connection: TransferConnection,
  signal: AbortSignal,
) {
  const url = new URL(grant.url);
  if (url.origin !== new URL(serverUrl).origin || !url.pathname.startsWith("/v1/agent/checkpoints/"))
    throw new Error("Checkpoint grant endpoint does not match the controller.");
  if (!Number.isFinite(Date.parse(grant.expires_at)) || Date.parse(grant.expires_at) <= Date.now())
    throw new Error("Checkpoint grant has expired.");
  signal.throwIfAborted();
  return {
    url,
    headers: {
      authorization: `Bearer ${grant.credential}`,
      "x-pocketcoder-workspace": connection.workspaceId,
      "x-pocketcoder-connection": connection.connectionId,
      "x-pocketcoder-epoch": String(connection.epoch),
      "x-pocketcoder-operation": grant.operation_id,
      "x-checkpoint-transfer-id": grant.transfer_id,
    },
  };
}
