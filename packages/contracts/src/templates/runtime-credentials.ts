import { secretMountPath, type TemplateSpec } from "./template-schema";

export function runtimeCredentialReferences(spec: TemplateSpec) {
  const envs = [spec.env, spec.agent?.env, spec.harness?.env, spec.terminal?.env, spec.checkpointHook?.env];
  return [
    ...new Set(
      envs
        .flatMap((env) => Object.values(env ?? {}))
        .filter((value) => value.startsWith("secretRef:"))
        .map((value) => value.slice(10)),
    ),
  ];
}

export function credentialMemoryPaths(spec: TemplateSpec) {
  const paths = spec.security.writableMemoryPaths;
  return runtimeCredentialReferences(spec).length ? [...new Set([...paths, "/run/pocketcoder/secrets"])] : paths;
}

export function runtimeCredentialPath(reference: string) {
  return secretMountPath(reference).replace("/secrets/", "/secrets/leases/");
}
