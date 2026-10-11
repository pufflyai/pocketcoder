import { isDeepStrictEqual } from "node:util";
import { hasNoPodAdmission } from "./kubernetes-empty-evidence";
import { EVIDENCE_FINALIZER, podHasStopped } from "./kubernetes-evidence";
import type { Resource } from "./kubernetes-evidence-types";

// A provider name can be reused. Only its immutable admission identity can bind a saved exit proof.
export function hasMatchingKubernetesTermination(
  ref: { jobUid?: string; neverAdmitted?: { inputUid: string; workspaceId: string; templateDigest: string } },
  proof: Record<string, unknown>,
) {
  if (!ref.jobUid) return Boolean(ref.neverAdmitted && isDeepStrictEqual(ref.neverAdmitted, proof.neverAdmitted));
  const job = proof.job as Resource | undefined;
  if (job?.metadata?.uid !== ref.jobUid || !Array.isArray(proof.pods)) return false;
  const pods = proof.pods as Resource[];
  if (!pods.length) return hasNoPodAdmission(job, EVIDENCE_FINALIZER);
  return pods.every(
    (pod) =>
      Boolean(
        pod.metadata?.uid &&
          pod.metadata.ownerReferences?.some(
            (owner) => owner.kind === "Job" && owner.controller && owner.uid === ref.jobUid,
          ),
      ) && podHasStopped(pod),
  );
}
