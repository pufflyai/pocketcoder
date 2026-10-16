import {
  ApiError,
  canonicalJson,
  digestOf,
  WORKLOAD_OPERATION_CAPABILITIES,
  type WorkloadAcceptance,
  type WorkloadInputProperty,
} from "@pstdio/pocketcoder-contracts";
import type { WorkspaceRow } from "@pstdio/pocketcoder-runtime-contracts";

export function executionConflict(message: string): never {
  throw new ApiError("operation.conflict", message);
}

export function validateExecution(row: WorkspaceRow, input: WorkloadAcceptance, at: Date) {
  const runtime = row.runtimeRegistration;
  if (row.principalId !== input.callerPrincipalId) executionConflict("Execution caller does not own the workspace.");
  if (
    row.purgeRequestedAt ||
    row.state !== "ready" ||
    row.deadlineAt <= at ||
    !runtime?.readyAt ||
    runtime.endedAt ||
    runtime.incarnationId !== input.execution.incarnationId
  )
    executionConflict("Execution requires a live, ready incarnation within its deadline.");
  const { template, installed } = installedEvidence(row, input);
  const spec = template.manifest.spec;
  const operation = Object.hasOwn(spec.operations, input.operation) ? spec.operations[input.operation] : undefined;
  const declared = operation && spec.adapters[operation.adapter];
  const adapter = operation && installed.adapters[operation.adapter];
  if (
    !operation ||
    !declared ||
    !adapter ||
    input.adapterDigest !== adapter.digest ||
    declared.digest !== adapter.digest ||
    declared.protocol !== adapter.protocol ||
    declared.kind !== adapter.kind
  )
    executionConflict("Installed operation adapter does not match acceptance.");
  validateOwner(input, adapter.kind, adapter.protocol, runtime.profile);
  for (const capability of new Set([
    ...WORKLOAD_OPERATION_CAPABILITIES[runtime.profile],
    ...operation.requiredCapabilities,
  ]))
    if (!adapter.capabilities.includes(capability) || !installed.capabilities.includes(capability))
      executionConflict(`Unavailable operation capability: ${capability}`);
  if (!matchesInput(operation.inputSchema, input.input))
    executionConflict("Operation input does not match its schema.");
  // Delegated customer grants plug in here once their authority owner exists.
  if (Object.keys(spec.credentialSlots).length || input.bindingSetDigest !== digestOf([]))
    executionConflict("This boundary requires the explicit empty binding set.");
  if (input.inputs.objects.length && !installed.capabilities.includes("immutable-inputs"))
    executionConflict("Installed immutable input support is required.");
  validateInputLimits(input, spec.limits);
}

function validateOwner(input: WorkloadAcceptance, kind: string, protocol: string, profile: string) {
  const owner = kind === "process" ? "process" : "conversation-request";
  if (input.execution.owner !== owner || (owner === "process" && profile !== "finite-process"))
    executionConflict("Execution owner does not match the installed adapter.");
  if (owner === "conversation-request" && protocol !== "pocketcoder.execution/v1")
    executionConflict("Service adapter has no execution protocol.");
}

function validateInputLimits(
  input: WorkloadAcceptance,
  limits: import("@pstdio/pocketcoder-contracts").WorkloadLimits,
) {
  const objects = input.inputs.objects;
  if (
    objects.length > limits.inputFiles ||
    objects.some((o) => o.sizeBytes > limits.inputFileBytes) ||
    objects.reduce((sum, o) => sum + o.sizeBytes, 0) > limits.stagedInputBytes
  )
    executionConflict("Accepted inputs exceed template limits.");
}

function installedEvidence(row: WorkspaceRow, input: WorkloadAcceptance) {
  const runtime = row.runtimeRegistration;
  if (!runtime) executionConflict("Runtime is not registered.");
  const template = runtime.template;
  const installed = runtime.producer;
  if (
    !template ||
    !installed ||
    template.digest !== input.templateDigest ||
    row.templateDigest !== input.templateDigest ||
    installed.templateDigest !== input.templateDigest ||
    installed.workspaceId !== row.id ||
    installed.incarnationId !== runtime.incarnationId ||
    installed.image !== template.manifest.spec.image ||
    canonicalJson(installed.runtime) !== canonicalJson(template.manifest.spec.runtime)
  )
    executionConflict("Installed producer and template evidence is required.");
  return { template, installed };
}

function matchesInput(schema: WorkloadInputProperty, value: unknown): boolean {
  switch (schema.type) {
    case "null":
      return value === null;
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value) && value.every((v) => matchesInput(schema.items, v));
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const input = value as Record<string, unknown>;
      return (
        schema.required.every((key) => Object.hasOwn(input, key)) &&
        Object.entries(input).every(
          ([key, v]) => Object.hasOwn(schema.properties, key) && matchesInputProperty(schema.properties[key], v),
        )
      );
    }
  }
}

function matchesInputProperty(schema: WorkloadInputProperty | undefined, value: unknown) {
  return schema !== undefined && matchesInput(schema, value);
}
