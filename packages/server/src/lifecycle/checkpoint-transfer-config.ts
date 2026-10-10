import { mkdirSync, realpathSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { CHECKPOINT_ENTRY_BYTES } from "@pstdio/pocketcoder-contracts";
import type { StorageCapacity } from "@pstdio/pocketcoder-runtime-core";
import type { ServerConfig } from "../config/config";
import type { CheckpointTransferOptions } from "../persistence/checkpoint-runtime";

export function checkpointTransferOptions(config: ServerConfig): CheckpointTransferOptions | undefined {
  if (config.storageBackend === "disabled" || !config.checkpointDir) return;
  mkdirSync(config.checkpointDir, { recursive: true, mode: 0o700 });
  const directory = realpathSync(config.checkpointDir);
  const limits = config.persistenceLimits;
  const maxIndexBytes = limits.maxCheckpointFiles * (CHECKPOINT_ENTRY_BYTES + 512) * 4;
  return {
    directory,
    agentBaseUrl: config.workspaceServerUrl,
    retentionLimits: limits,
    limits: {
      deadlineMs: 60_000,
      maxArchiveBytes: limits.maxRetainedBytes,
      maxIndexBytes,
      maxQueueBytes: 8 * 1024 ** 2,
      maxLedgerBytes: maxIndexBytes,
    },
    readCapacity: async (): Promise<StorageCapacity> => {
      const disk = await statfs(directory);
      const files = limits.maxCheckpointFiles * limits.maxCheckpointsPerPrincipal;
      return {
        workspace: { bytes: limits.maxRetainedBytesPerPrincipal, files },
        principal: { bytes: limits.maxRetainedBytesPerPrincipal, files },
        instance: { bytes: limits.maxRetainedBytes, files },
        freeDisk: {
          bytes: disk.bavail * disk.bsize,
          files: disk.ffree,
          headroomBytes: 64 * 1024 ** 2,
          headroomFiles: 16,
        },
      };
    },
  };
}
