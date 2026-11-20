import { ApiError } from "@pstdio/pocketcoder-contracts";
import { isKubernetesName } from "./kubernetes-command";
import { type KubernetesSchedulingOptions, validateToleration } from "./kubernetes-scheduling";

export interface KubernetesPlacementProfile extends KubernetesSchedulingOptions {
  containerEngine?: boolean;
  maxWorkspaces?: number;
}
export interface KubernetesPlacementConfig {
  placementProfiles: Record<string, KubernetesPlacementProfile>;
  templatePlacement: Record<string, string[]>;
  vmRuntimeHandlers: string[];
}

export class KubernetesPlacement {
  constructor(
    readonly profiles: Record<string, KubernetesPlacementProfile> = { default: {} },
    readonly templates: Record<string, string[]> = {},
    readonly vmHandlers: string[] = [],
  ) {
    if (!profiles.default) throw new Error("placementProfiles.default is required");
    for (const [name, profile] of Object.entries(profiles)) validateProfile(name, profile, vmHandlers);
  }

  resolve(template: string, name = "default") {
    const profile = this.profiles[name];
    if (!profile) throw new ApiError("placement_unavailable", `Placement ${name} is unavailable.`);
    if (name !== "default" && !this.templates[template]?.includes(name))
      throw new ApiError("placement_not_allowed", `Template ${template} is not allowed to use ${name}.`);
    return profile;
  }
  async verifyProfiles(read: (name: string) => Promise<{ handler: string }>) {
    for (const profile of Object.values(this.profiles)) if (profile.containerEngine) await this.verify(profile, read);
  }
  async verify(profile: KubernetesPlacementProfile, read: (name: string) => Promise<{ handler: string }>) {
    if (!profile.runtimeClassName) return;
    const runtime = await read(profile.runtimeClassName);
    if (
      profile.containerEngine &&
      (!this.vmHandlers.includes(runtime.handler) || !/^kata(?:-|$)/.test(runtime.handler))
    )
      throw new Error("Container engine RuntimeClass does not resolve to a listed Kata VM handler");
  }
}

function validateProfile(name: string, profile: KubernetesPlacementProfile, vmHandlers: string[]) {
  if (!isKubernetesName(name)) throw new Error("Placement profile must have a Kubernetes name");
  if (profile.runtimeClassName !== undefined && !isKubernetesName(profile.runtimeClassName))
    throw new Error("Invalid runtimeClassName");
  for (const t of profile.tolerations ?? []) validateToleration(t);
  if (profile.maxWorkspaces !== undefined && (!Number.isInteger(profile.maxWorkspaces) || profile.maxWorkspaces < 1))
    throw new Error("maxWorkspaces must be a positive integer");
  if (profile.containerEngine) {
    if (name === "default") throw new Error("The default placement cannot enable a container engine");
    if (
      !profile.runtimeClassName ||
      vmHandlers.length === 0 ||
      vmHandlers.some((handler) => !/^kata(?:-|$)/.test(handler))
    )
      throw new Error("A container engine requires a listed Kata VM RuntimeClass and handler");
  }
}
