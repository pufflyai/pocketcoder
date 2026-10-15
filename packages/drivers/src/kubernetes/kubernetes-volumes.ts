import { posix } from "node:path";
import { credentialMemoryPaths } from "@pstdio/pocketcoder-contracts";
import type { RuntimeMountRef, WorkspaceLaunch } from "@pstdio/pocketcoder-runtime-core";
import type { KubernetesSharedStorage } from "./kubernetes-shared-storage";

export interface ResolvedSharedMount {
  claimName: string;
  subPath: string;
}
export function persistentVolumes(mounts: RuntimeMountRef[], shared: Map<number, ResolvedSharedMount> = new Map()) {
  const volumes = mounts.map((mount, index) => {
    const resolved = shared.get(index);
    if (mount.source.kind === "shared-filesystem" && resolved)
      return {
        name: `persistent-${index}`,
        // Kubelet shares the claim's backing mount. Restrict each input bind,
        // so that the same claim can still serve writable output subdirectories.
        persistentVolumeClaim: { claimName: resolved.claimName },
      };
    if (mount.source.kind !== "empty-dir")
      throw new Error("Kubernetes mount requires configured shared storage or bounded emptyDir");
    return { name: `persistent-${index}`, emptyDir: { sizeLimit: String(mount.source.maxBytes) } };
  });
  const volumeMounts = mounts.map((mount, index) => ({
    name: `persistent-${index}`,
    mountPath: mount.target,
    readOnly: !!mount.readOnly,
    ...(shared.has(index) ? { subPath: shared.get(index)?.subPath } : {}),
  }));
  return { volumes, volumeMounts };
}
function overlaps(a: string, b: string) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`) || a === "/" || b === "/";
}
function validateInputIsolation(launch: WorkspaceLaunch, shared: boolean) {
  const inputs = launch.mounts.filter(
    (mount) => mount.source.kind === "shared-filesystem" && mount.source.directory === "inputs",
  );
  if (inputs.length > 1) throw new Error("Duplicate immutable input mount");
  for (const path of credentialMemoryPaths(launch.workspace.templateSnapshot.spec))
    if (inputs.some((input) => overlaps(input.target, path))) throw new Error("Memory mount overlaps immutable inputs");
  if (shared && !launch.workspace.templateSnapshot.spec.security.dropCapabilities.includes("ALL"))
    throw new Error("Shared storage requires all workload capabilities dropped");
  for (const secret of launch.secrets)
    if (inputs.some((input) => overlaps(input.target, secret.target)))
      throw new Error("Secret overlaps immutable inputs");
}
export async function resolveSharedMounts(launch: WorkspaceLaunch, storage?: KubernetesSharedStorage) {
  validateInputIsolation(launch, !!storage);
  const result = new Map<number, ResolvedSharedMount>();
  for (const [index, mount] of launch.mounts.entries()) {
    if (posix.normalize(mount.target) !== mount.target || !posix.isAbsolute(mount.target))
      throw new Error("Mount targets must be normalized absolute paths");
    for (const other of launch.mounts.slice(index + 1))
      if (overlaps(mount.target, other.target)) throw new Error("Overlapping workspace mounts are not supported");
    if (mount.source.kind !== "shared-filesystem") continue;
    if (!storage) throw new Error("Shared storage is not configured");
    const resolved =
      mount.source.directory === "inputs"
        ? await storage.resolveInput(launch.workspace.id, mount)
        : await storage.resolveMount(launch.workspace.id, mount);
    result.set(index, resolved);
  }
  return result;
}
