import { ApiError } from "../common/errors";
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
    security: spec.security,
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
    persistence: lifecycle?.persistence,
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
    spec.profile !== "service" ||
    Object.values(spec.adapters).some((a) => a.kind !== "service" || a.protocol !== "pocketcoder.execution/v1")
  ) {
    throw new ApiError(
      "validation.invalid",
      "unsupported template format: only request-aware service workloads are qualified for publication",
    );
  }
  if (Object.values(spec.operations).some((operation) => operation.outputRoots.length))
    throw new ApiError("validation.invalid", "Service output publication is not qualified.");
  if (Object.keys(spec.credentialSlots).length)
    throw new ApiError("validation.invalid", "Workload credential slots are not qualified.");
  return { ...parsed, policy: workloadLifecycle(parsed.manifest), workload: parsed.manifest };
}
