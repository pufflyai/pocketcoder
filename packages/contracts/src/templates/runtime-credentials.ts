import { type RuntimeTemplatePolicy, secretMountPath } from "./template-schema";
import type { WorkloadTemplate } from "./workload-template";

export function runtimeCredentialReferences(spec: RuntimeTemplatePolicy) {
  const envs = [spec.env, spec.harness?.env, spec.terminal?.env, spec.checkpointHook?.env];
  return [
    ...new Set(
      envs
        .flatMap((env) => Object.values(env ?? {}))
        .filter((value) => value.startsWith("secretRef:"))
        .map((value) => value.slice(10)),
    ),
  ];
}

export function credentialMemoryPaths(spec: RuntimeTemplatePolicy) {
  const paths = spec.security.writableMemoryPaths;
  return runtimeCredentialReferences(spec).length ? [...new Set([...paths, "/run/pocketcoder/secrets"])] : paths;
}

export function runtimeCredentialPath(reference: string) {
  return secretMountPath(reference).replace("/secrets/", "/secrets/leases/");
}

// A managed session's own copy of a template credential, beside its siblings' copies.
export function sessionCredentialPath(sessionId: string, reference: string) {
  return runtimeCredentialPath(reference).replace("/leases/", `/leases/sessions/${sessionId}/`);
}

// A workload names its runtime credentials through fixed-scope slots. The slot's policyRef names
// the controller's issuer secret, so delivery reuses the same per-workspace, expiring leases.
export function workloadCredentialReferences(manifest: WorkloadTemplate) {
  return [
    ...new Set(
      Object.values(manifest.spec.credentialSlots)
        .filter((slot) => slot.binding === "fixed-scope")
        .map((slot) => slot.policyRef),
    ),
  ];
}

export function templateCredentialReferences(template: { spec: RuntimeTemplatePolicy; manifest?: WorkloadTemplate }) {
  return template.manifest
    ? workloadCredentialReferences(template.manifest)
    : runtimeCredentialReferences(template.spec);
}

// Replaces `credentialSlot:<slot>` env values with the file path its lease is written to.
export function materializeSlotEnv(manifest: WorkloadTemplate, env: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => {
      const slot = value.startsWith("credentialSlot:") ? manifest.spec.credentialSlots[value.slice(15)] : undefined;
      return [key, slot ? runtimeCredentialPath(`secretRef:${slot.policyRef}`) : value];
    }),
  );
}
