import { z } from "zod";
import {
  type InstalledWorkload,
  InstalledWorkloadSchema,
  WORKLOAD_OPERATION_CAPABILITIES,
  WORKLOAD_PROFILE_CAPABILITIES,
  WorkloadLimitsSchema,
  WorkloadProfileSchema,
} from "./workload-capabilities";
import { parseWorkloadTemplate, type WorkloadTemplate } from "./workload-template";

export const WorkloadDeploymentSchema = z.strictObject({
  workspaceId: z.uuid(),
  incarnationId: z.string().min(1).max(256),
  profiles: z.array(WorkloadProfileSchema),
  storageProfiles: z.array(z.enum(["controller-readonly/v1", "shared-writer-readonly/v1"])),
  ceilings: WorkloadLimitsSchema,
  now: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  installed: InstalledWorkloadSchema.optional(),
});
export type WorkloadDeployment = z.infer<typeof WorkloadDeploymentSchema>;

// Only the trusted driver/registration owner supplies installed evidence. Caller
// declarations and package versions cannot be promoted to observed support here.
export function workloadAdmission(parsed: ReturnType<typeof parseWorkloadTemplate>, input: unknown) {
  const deploymentResult = WorkloadDeploymentSchema.safeParse(input);
  if (!deploymentResult.success) return { supported: false as const, reasons: [deploymentResult.error.message] };
  const deployment = deploymentResult.data;
  const verified = parseWorkloadTemplate(parsed.manifest);
  const spec = verified.manifest.spec;
  const reasons: string[] = [];
  if (verified.digest !== parsed.digest) reasons.push("template digest does not match its manifest");
  if (!deployment.profiles.includes(spec.profile)) reasons.push(`unsupported profile: ${spec.profile}`);
  for (const key of Object.keys(spec.limits) as (keyof typeof spec.limits)[]) {
    if (spec.limits[key] > deployment.ceilings[key]) reasons.push(`deployment ceiling exceeded: ${key}`);
  }
  const lifetime = Date.parse(deployment.expiresAt) - Date.parse(deployment.now);
  if (lifetime <= 0 || lifetime / 1000 > spec.limits.deadlineSeconds)
    reasons.push("expiresAt must be future and within the declared deadline");
  const installed = deployment.installed;
  if (!installed) return { supported: false as const, reasons: [...reasons, "installed runtime evidence is required"] };
  if (installed.workspaceId !== deployment.workspaceId || installed.incarnationId !== deployment.incarnationId) {
    reasons.push("installed evidence belongs to a different workspace or incarnation");
  }
  if (
    installed.templateDigest !== verified.digest ||
    installed.image !== spec.image ||
    installed.runtime.digest !== spec.runtime.digest ||
    installed.runtime.protocol !== spec.runtime.protocol
  ) {
    reasons.push("installed template, image or runtime pin does not match");
  }
  if (!deployment.storageProfiles.includes(installed.storage.profile))
    reasons.push("installed storage profile is not qualified");
  for (const capability of WORKLOAD_PROFILE_CAPABILITIES[spec.profile]) {
    if (!installed.capabilities.includes(capability)) reasons.push(`runtime capability unavailable: ${capability}`);
  }
  reasons.push(...operationSupport(spec, installed));
  if (reasons.length) return { supported: false as const, reasons };
  return { supported: true as const, reasons, limits: spec.limits, installed };
}

function operationSupport(spec: WorkloadTemplate["spec"], installed: InstalledWorkload) {
  const reasons: string[] = [];
  for (const [name, operation] of Object.entries(spec.operations)) {
    const declared = Object.hasOwn(spec.adapters, operation.adapter) ? spec.adapters[operation.adapter] : undefined;
    const producer = Object.hasOwn(installed.adapters, operation.adapter)
      ? installed.adapters[operation.adapter]
      : undefined;
    if (
      !declared ||
      !producer ||
      producer.digest !== declared.digest ||
      producer.protocol !== declared.protocol ||
      producer.kind !== declared.kind
    ) {
      reasons.push(`installed adapter pin does not match: ${operation.adapter}`);
      continue;
    }
    for (const capability of new Set([
      ...WORKLOAD_OPERATION_CAPABILITIES[spec.profile],
      ...operation.requiredCapabilities,
    ])) {
      if (!producer.capabilities.includes(capability) || !installed.capabilities.includes(capability)) {
        reasons.push(`operation ${name} capability unavailable: ${capability}`);
      }
    }
  }
  return reasons;
}
