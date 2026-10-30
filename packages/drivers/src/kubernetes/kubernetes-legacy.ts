import type { ProviderRef } from "@pstdio/pocketcoder-runtime-core";
import type { Resource } from "./kubernetes-evidence-types";
import { jobUidOf, type KubernetesCommand, neverAdmittedInputUid } from "./kubernetes-identity";
import { KUBERNETES_DIGEST_ANNOTATION, KUBERNETES_POOL_LABEL, KUBERNETES_WORKSPACE_LABEL } from "./kubernetes-labels";

// 0.8 saved Job names without UIDs. A Job name comes from its unique workspace or
// warm runtime ID, and every later launch saves its UID with the reference. So the
// live Job with this name, owner label and template digest is the saved launch.
// The TTL controller deletes finished Jobs in the foreground: the evidence
// finalizer on their Pods keeps the Job readable until cleanup releases them.
export async function legacyKubernetesProvider(
  run: KubernetesCommand,
  ref: ProviderRef,
  owner: { id: string; templateDigest: string },
): Promise<ProviderRef | null> {
  if (ref.jobUid || neverAdmittedInputUid(ref)) return null;
  const output = await run(["get", "job", ref.id, "--ignore-not-found", "-o", "json"]);
  if (!output) throw new Error(`Legacy Kubernetes Job ${ref.id} is gone; its termination is unproved`);
  const job = JSON.parse(output) as Resource;
  const [label, ownerId] =
    typeof ref.poolRuntimeId === "string"
      ? [KUBERNETES_POOL_LABEL, ref.poolRuntimeId]
      : [KUBERNETES_WORKSPACE_LABEL, owner.id];
  if (
    job.metadata.labels?.[label] !== ownerId ||
    job.metadata.annotations?.[KUBERNETES_DIGEST_ANNOTATION] !== owner.templateDigest
  )
    throw new Error(`Legacy Kubernetes Job ${ref.id} has another owner or template`);
  return { ...ref, jobUid: jobUidOf(job) };
}
