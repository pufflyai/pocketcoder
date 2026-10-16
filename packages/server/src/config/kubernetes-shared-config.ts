import type { KubernetesSharedStorageOptions } from "@pstdio/pocketcoder-drivers";
import { z } from "zod";

const bound = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const SharedStorageConfig = z.strictObject({
  root: z.string().startsWith("/"),
  claimName: z.string().min(1),
  volumeName: z.string().min(1),
  storageClassName: z.string().min(1),
  networkPolicyName: z.string().min(1),
  storageCidrs: z.array(z.string()).min(1),
  profile: z.literal("shared-writer-readonly/v1"),
  maxBytes: bound,
  maxFiles: bound,
});
export function kubernetesSharedConfig(
  raw: string | undefined,
  checkpointRoot: string | null,
  backend: string,
): KubernetesSharedStorageOptions | undefined {
  if ((backend === "kubernetes-shared") !== (raw !== undefined))
    throw new Error("POCKETCODER_KUBERNETES_SHARED_STORAGE requires POCKETCODER_STORAGE_BACKEND=kubernetes-shared");
  if (raw === undefined) return;
  if (!checkpointRoot) throw new Error("Shared storage requires POCKETCODER_CHECKPOINT_DIR");
  return { ...SharedStorageConfig.parse(JSON.parse(raw)), checkpointRoot };
}
