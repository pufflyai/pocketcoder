import { join } from "node:path";

export function inputEnvironment(root: string, limits: Record<string, number>) {
  const capacity = { bytes: limits.stagedInputBytes, files: limits.inputFiles };
  return {
    POCKETCODER_WORKLOAD_LIMITS: JSON.stringify(limits),
    POCKETCODER_INPUT_DIR: join(root, "launch"),
    POCKETCODER_INPUT_STORAGE: JSON.stringify({
      root: join(root, "inputs"),
      projection: {
        root: join(root, "projection"),
        probeImage: "oven/bun@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895",
        capacity,
      },
      limits: {
        fileBytes: limits.inputFileBytes,
        stagedBytes: limits.stagedInputBytes,
        files: limits.inputFiles,
        transfers: limits.inFlightTransfers,
        transferMs: limits.finalizationSeconds * 1000,
        retentionMs: limits.unreferencedInputRetentionSeconds * 1000,
      },
      principal: capacity,
      instance: capacity,
      headroom: { bytes: limits.inputFileBytes, files: limits.inputFiles },
    }),
  };
}
