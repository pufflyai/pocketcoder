import { ApiError, type RuntimeTemplatePolicy } from "@pstdio/pocketcoder-contracts";
import { KubernetesPlacement, type KubernetesPlacementConfig } from "@pstdio/pocketcoder-drivers";

export function templatePlacementPolicy(config: KubernetesPlacementConfig | undefined, driver: string) {
  const placement = new KubernetesPlacement(
    config?.placementProfiles,
    config?.templatePlacement,
    config?.vmRuntimeHandlers,
  );
  return (name: string, spec: RuntimeTemplatePolicy) => {
    if (driver !== "kubernetes" && spec.placement && spec.placement !== "default")
      throw new ApiError("placement_unavailable", "Named placements require Kubernetes.");
    return placement.resolve(name, spec.placement);
  };
}

// Recheck queued work after a controller restart or an operator policy change.
export function placementLaunchPolicy(
  check: ReturnType<typeof templatePlacementPolicy> | undefined,
  next: import("@pstdio/pocketcoder-runtime-core").SchedulerDeps["authorizeLaunch"],
) {
  if (!check) return next;
  return async (workspace: import("@pstdio/pocketcoder-runtime-core").WorkspaceRow) => {
    check(workspace.templateName, workspace.templateSnapshot.spec);
    return next ? next(workspace) : true;
  };
}
