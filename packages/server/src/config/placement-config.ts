import { KubernetesPlacement, type KubernetesPlacementConfig } from "@pstdio/pocketcoder-drivers";
import { z } from "zod";
import { resolveKubernetesScheduling } from "./kubernetes-scheduling-config";

const name = z.string().regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/);
const profile = z.strictObject({
  runtimeClassName: name.optional(),
  nodeSelector: z.record(z.string(), z.string()).optional(),
  tolerations: z
    .array(
      z.strictObject({
        key: z.string().optional(),
        operator: z.enum(["Exists", "Equal"]).optional(),
        value: z.string().optional(),
        effect: z.literal("NoSchedule"),
      }),
    )
    .optional(),
  containerEngine: z.boolean().optional(),
  maxWorkspaces: z.number().int().positive().optional(),
});
const schema = z.strictObject({
  placementProfiles: z.record(name, profile),
  templatePlacement: z.record(name, z.array(name)),
  vmRuntimeHandlers: z.array(name),
});
export function placementConfig(env: Record<string, string | undefined>): KubernetesPlacementConfig {
  const raw = env.POCKETCODER_PLACEMENT_CONFIG;
  const config = raw
    ? schema.parse(JSON.parse(raw))
    : {
        placementProfiles: { default: resolveKubernetesScheduling(env) },
        templatePlacement: {},
        vmRuntimeHandlers: [],
      };
  new KubernetesPlacement(config.placementProfiles, config.templatePlacement, config.vmRuntimeHandlers);
  return config;
}
