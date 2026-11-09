import { ApiError } from "../common/errors";
import { SecretNameSchema } from "../secrets/secret";
import { finiteOutputMounts } from "./finite-outputs";
import { workloadCredentialReferences } from "./runtime-credentials";
import { parseTemplateManifest } from "./template";
import { RuntimeTemplatePolicySchema, ServiceSchema } from "./template-alpha-schema";
import { isWorkloadTemplate } from "./workload-format";
import { parseWorkloadTemplate, type WorkloadTemplate } from "./workload-template";

// The authored manifest remains the immutable identity. Lifecycle owners share
// this policy; no alpha agent or automatic user task is fabricated for a workload.
export function workloadLifecycle(manifest: WorkloadTemplate) {
  const spec = manifest.spec;
  const lifecycle = spec.lifecycle;
  const duration = `${spec.limits.deadlineSeconds}s`;
  const policy = RuntimeTemplatePolicySchema.parse({
    command: [
      "/usr/local/bin/bun",
      "/opt/pocketcoder/supervisor.js",
      "supervise",
      "--launch-input",
      "/run/pocketcoder/input",
    ],
    version: spec.version,
    image: spec.image,
    resources: spec.resources,
    security: {
      ...spec.security,
      // Service control must work even when the authored root has no writable paths.
      writableMemoryPaths: [
        "/run/pocketcoder/services",
        ...(workloadCredentialReferences(manifest).length ? ["/run/pocketcoder/secrets"] : []),
        ...spec.security.writableMemoryPaths,
      ],
    },
    network: spec.network,
    previews: spec.previews,
    services: Object.fromEntries(
      Object.entries(spec.services).map(([name, service]) => [name, ServiceSchema.parse(service)]),
    ),
    timeouts: lifecycle?.timeouts ?? {
      start: duration,
      idle: duration,
      maxAge: duration,
      disconnectGrace: duration,
      terminateGrace: `${spec.limits.finalizationSeconds}s`,
    },
    persistence: {
      ...lifecycle?.persistence,
      mounts: [...(lifecycle?.persistence.mounts ?? []), ...finiteOutputMounts(spec)],
    },
    checkpointHook: lifecycle?.checkpointHook,
    maxLaunchInputBytes: lifecycle?.maxLaunchInputBytes,
  });
  return policy;
}

export function runtimeTemplateDefinition(input: unknown) {
  if (!isWorkloadTemplate(input)) {
    const parsed = parseTemplateManifest(input);
    return { ...parsed, policy: parsed.manifest.spec, workload: null };
  }
  const parsed = parseWorkloadTemplate(input);
  const spec = parsed.manifest.spec;
  if (
    spec.profile !== "finite-process" &&
    (spec.profile !== "service" ||
      Object.values(spec.adapters).some((a) => a.kind !== "service" || a.protocol !== "pocketcoder.execution/v1"))
  ) {
    throw new ApiError(
      "validation.invalid",
      "unsupported template format: only finite-process and request-aware service workloads are qualified for publication",
    );
  }
  // Fixed-scope slots are workspace runtime credentials from the controller's issuer. Delegated
  // post-create grants have no authority owner yet.
  for (const slot of Object.values(spec.credentialSlots)) {
    if (slot.binding !== "fixed-scope")
      throw new ApiError("validation.invalid", "Post-create credential grants are not qualified.");
    if (!SecretNameSchema.safeParse(slot.policyRef).success)
      throw new ApiError("validation.invalid", "A fixed-scope credential slot must name an issuer secret.");
  }
  if (spec.lifecycle?.persistence.mounts.length && !spec.lifecycle.checkpointHook)
    throw new ApiError("validation.invalid", "Persistent service workloads require an image-owned checkpoint hook.");
  return { ...parsed, policy: workloadLifecycle(parsed.manifest), workload: parsed.manifest };
}
