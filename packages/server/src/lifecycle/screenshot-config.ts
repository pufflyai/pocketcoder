import { statfs } from "node:fs/promises";
import type { ServerConfig } from "../config/config";
import type { ScreenshotOptions } from "../displays/screenshots";

export function screenshotOptions(config: ServerConfig): ScreenshotOptions {
  const limits = config.persistenceLimits;
  return {
    agentBaseUrl: config.workspaceServerUrl,
    readCapacity: async () => {
      const disk = await statfs(config.dataDir);
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
