import { RuntimeIdentitySchema } from "@pstdio/pocketcoder-db/off-node";
import {
  hasMatchingKubernetesTermination,
  type KubernetesEvidenceResource,
  podHasStopped,
} from "@pstdio/pocketcoder-drivers";
import { z } from "zod";
import type { Account } from "../database/store";
import type { kube } from "./command";
import { restoreJobName } from "./restore-manifests";

const Runtime = z.object({
  evidence: z.array(
    z.object({
      provider: z.string().nullable(),
      admitted: z.boolean(),
      ref: RuntimeIdentitySchema.shape.ref.nullable(),
      termination: z.record(z.string(), z.unknown()).nullable(),
    }),
  ),
});
const Proof = z.object({ runtime: Runtime, controllerTermination: z.array(z.record(z.string(), z.unknown())).min(1) });

export async function proveSourceStopped(
  command: typeof kube,
  account: Account,
  input: Record<string, unknown>,
  restoreId?: string,
) {
  const proof = Proof.parse(input);
  if (!proof.controllerTermination.every((pod) => podHasStopped(pod as unknown as KubernetesEvidenceResource)))
    throw new Error("Source controller termination is uncertain.");
  for (const runtime of proof.runtime.evidence) {
    if (runtime.provider !== "kubernetes") continue;
    if (!runtime.admitted) continue;
    if (!runtime.termination) throw new Error("Source runtime termination proof is missing.");
    if (!runtime.ref || !hasMatchingKubernetesTermination(runtime.ref, runtime.termination))
      throw new Error("Source runtime termination identity is uncertain.");
  }
  const deployment = JSON.parse(
    await command(["-n", account.namespace, "get", "deployment", "controller", "-o", "json"]),
  );
  if (deployment.metadata.labels?.["pocketcoder.dev/account"] !== account.id || deployment.spec.replicas !== 0)
    throw new Error("Source controller can still start.");
  await proveInventory(command, account, restoreId);
  const volume = JSON.parse(await command(["-n", account.namespace, "get", "pvc", account.volumeName, "-o", "json"]));
  if (volume.metadata.labels?.["pocketcoder.dev/account"] !== account.id || !volume.metadata.uid)
    throw new Error("Source volume identity is missing.");
  return { name: account.volumeName, uid: volume.metadata.uid as string };
}

async function proveInventory(command: typeof kube, account: Account, restoreId?: string) {
  const jobs = JSON.parse(await command(["-n", account.namespace, "get", "jobs", "-o", "json"]));
  const job = restoreId
    ? jobs.items.find((item: { metadata: { name: string } }) => item.metadata.name === restoreJobName(restoreId))
    : null;
  const ownedJob =
    job?.metadata.labels?.["pocketcoder.dev/account"] === account.id &&
    job?.metadata.labels?.["pocketcoder.dev/restore"] === restoreId;
  if (jobs.items.length !== (ownedJob ? 1 : 0)) throw new Error("Source account jobs remain.");
  const pods = JSON.parse(await command(["-n", account.namespace, "get", "pods", "-o", "json"]));
  for (const pod of pods.items as KubernetesEvidenceResource[]) {
    if (
      !ownedJob ||
      pod.metadata.labels?.["pocketcoder.dev/account"] !== account.id ||
      pod.metadata.labels?.["pocketcoder.dev/restore"] !== restoreId ||
      !pod.metadata.ownerReferences?.some((owner) => owner.kind === "Job" && owner.uid === job.metadata.uid)
    )
      throw new Error("Source account compute remains.");
  }
}
