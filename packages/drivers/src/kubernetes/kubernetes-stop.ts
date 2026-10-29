import type { ProviderRef } from "@pstdio/pocketcoder-runtime-core";
import type { Resource } from "./kubernetes-evidence-types";
import {
  deleteResource,
  jobUidOf,
  type KubernetesCommand,
  referencedJob,
  waitForDeletion,
} from "./kubernetes-identity";

export async function stopKubernetesJob(
  run: KubernetesCommand,
  namespace: string,
  ref: ProviderRef,
  graceSeconds: number,
) {
  const job = await referencedJob(run, ref);
  if (!job) return;
  const uid = jobUidOf(job);
  await run([
    "patch",
    "job",
    ref.id,
    "--type=merge",
    "-p",
    JSON.stringify({ metadata: { uid }, spec: { suspend: true } }),
  ]);
  const { items } = JSON.parse(await run(["get", "pods", "-l", `job-name=${ref.id}`, "-o", "json"])) as {
    items: Resource[];
  };
  if (
    items.some(
      (pod) =>
        !pod.metadata.ownerReferences?.some((owner) => owner.kind === "Job" && owner.controller && owner.uid === uid),
    )
  )
    throw new Error("Termination provider changed");
  for (const pod of items) {
    if (!pod.metadata.name) throw new Error("Termination evidence unavailable");
    const podUid = jobUidOf(pod);
    await deleteResource(run, namespace, "pods", pod.metadata.name, podUid, graceSeconds);
    await waitForDeletion(run, "pod", pod.metadata.name, podUid);
  }
}
