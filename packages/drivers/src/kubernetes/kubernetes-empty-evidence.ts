import type { Resource } from "./kubernetes-evidence-types";

export const ADMISSION_ANNOTATION = "pocketcoder.dev/pod-admitted";

export function hasNoPodAdmission(job: Resource, finalizer: string) {
  // The immutable template retains every accepted Pod until durable proof exists.
  // Empty inventory without this provenance cannot prove a runtime never existed.
  if (!job.spec?.template?.metadata?.finalizers?.includes(finalizer)) return false;
  if (job.metadata.annotations?.[ADMISSION_ANNOTATION]) return false;
  const status = job.status;
  return (
    [status?.active, status?.ready, status?.terminating, status?.succeeded, status?.failed].every(
      (count) => count === undefined || count === 0,
    ) &&
    !status?.uncountedTerminatedPods?.succeeded?.length &&
    !status?.uncountedTerminatedPods?.failed?.length
  );
}
