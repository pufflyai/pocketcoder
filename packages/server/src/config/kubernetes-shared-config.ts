import type { KubernetesSharedStorageOptions } from "@pstdio/pocketcoder-drivers";
import { z } from "zod";

const bound = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const SharedStorageConfig = z.strictObject({
  root: z.string().startsWith("/"),
  claimSubPath: z.string().min(1).optional(),
  claimName: z.string().min(1),
  volumeName: z.string().min(1),
  storageClassName: z.string().min(1),
  networkPolicyName: z.string().min(1),
  storageCidrs: z.array(z.string()).min(1),
  storageOutsidePodNetwork: z.boolean().optional(),
  profile: z.literal("shared-writer-readonly/v1"),
  maxBytes: bound,
  maxFiles: bound,
});
export function kubernetesSharedConfig(
  raw: string | undefined,
  checkpointRoot: string | null,
  backend: string,
): KubernetesSharedStorageOptions | undefined {
  if (backend === "kubernetes-shared" && raw === undefined)
    throw new Error("POCKETCODER_STORAGE_BACKEND=kubernetes-shared requires POCKETCODER_KUBERNETES_SHARED_STORAGE");
  if (raw === undefined) return;
  // With controller-archive, the claim only carries immutable inputs; workspace storage stays disposable.
  if (backend !== "kubernetes-shared" && backend !== "controller-archive")
    throw new Error(
      "POCKETCODER_KUBERNETES_SHARED_STORAGE requires POCKETCODER_STORAGE_BACKEND=kubernetes-shared or controller-archive",
    );
  if (!checkpointRoot) throw new Error("Shared storage requires POCKETCODER_CHECKPOINT_DIR");
  return { ...SharedStorageConfig.parse(JSON.parse(raw)), checkpointRoot };
}
