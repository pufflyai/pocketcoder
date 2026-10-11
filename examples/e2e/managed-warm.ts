import { WarmPoolInventorySchema } from "@pstdio/pocketcoder-contracts";
import { BackupRuntimeProofSchema } from "@pstdio/pocketcoder-db/off-node";
import { hasMatchingKubernetesTermination, podHasStopped } from "@pstdio/pocketcoder-drivers";
import { waitFor } from "./local-process";
import type { managedLifecycleFixture } from "./managed-lifecycle-fixture";

export async function prepareManagedWarm(
  fixture: Awaited<ReturnType<typeof managedLifecycleFixture>>,
  namespace: string,
  template: string,
  token: string,
) {
  await fixture.cluster.kube([
    "-n",
    namespace,
    "set",
    "env",
    "deployment/controller",
    `POCKETCODER_WARM_POOLS=${JSON.stringify([{ template, min_ready: 1 }])}`,
  ]);
  await fixture.cluster.kube(["-n", namespace, "rollout", "status", "deployment/controller", "--timeout=120s"]);
  const url = await fixture.connect(namespace);
  await waitFor(
    async () => {
      const response = await fetch(`${url}/v1/warm-pools`, { headers: { authorization: `Bearer ${token}` } });
      return (WarmPoolInventorySchema.parse(await response.json()).items[0]?.counts.ready ?? 0) >= 1;
    },
    30_000,
    "warm runtime ready before backup",
  );
  return url;
}

export async function observeManagedWarm(
  fixture: Awaited<ReturnType<typeof managedLifecycleFixture>>,
  namespace: string,
) {
  const jobs = JSON.parse(
    await fixture.cluster.kube(["-n", namespace, "get", "jobs", "-l", "pocketcoder.pool-runtime", "-o", "json"]),
  ).items;
  const pods = JSON.parse(
    await fixture.cluster.kube(["-n", namespace, "get", "pods", "-l", "pocketcoder.pool-runtime", "-o", "json"]),
  ).items;
  if (jobs.length !== 1 || pods.length !== 1) throw new Error("Expected one actual warm Job and Pod before capture.");
  const job = jobs[0];
  const pod = pods[0];
  const runtime = job.metadata.labels["pocketcoder.pool-runtime"];
  if (
    !runtime ||
    !job.metadata.uid ||
    !pod.metadata.uid ||
    pod.status.phase !== "Running" ||
    !pod.status.containerStatuses?.every((status: { ready: boolean }) => status.ready) ||
    !pod.metadata.ownerReferences?.some(
      (owner: { kind: string; uid: string }) => owner.kind === "Job" && owner.uid === job.metadata.uid,
    )
  )
    throw new Error("Warm capture identity or actual ready container is missing.");
  const captured = {
    runtime: runtime as string,
    job: job.metadata.name as string,
    jobUid: job.metadata.uid as string,
    podUid: pod.metadata.uid as string,
  };
  console.log(JSON.stringify({ captureWarm: captured }));
  return captured;
}

export async function requireManagedWarmProof(
  fixture: Awaited<ReturnType<typeof managedLifecycleFixture>>,
  operationId: string,
  backupId: string,
  captured: Awaited<ReturnType<typeof observeManagedWarm>>,
) {
  const operation = await fixture.currentStore()?.getOperation(operationId);
  const backups = operation?.computeProof?.backups as Record<string, unknown> | undefined;
  const proof = BackupRuntimeProofSchema.parse(backups?.[backupId]);
  const warm = proof.runtimes.find(
    (runtime) => runtime.identity.kind === "warm" && runtime.identity.id === captured.runtime,
  );
  if (
    !warm ||
    warm.identity.ref.id !== captured.job ||
    warm.identity.ref.jobUid !== captured.jobUid ||
    !hasMatchingKubernetesTermination(warm.identity.ref, warm.termination)
  )
    throw new Error("Archived ready warm Job proof differs from actual capture.");
  const pods = warm.termination.pods as Parameters<typeof podHasStopped>[0][];
  if (!pods.some((pod) => pod.metadata.uid === captured.podUid && podHasStopped(pod)))
    throw new Error("Archived ready warm container exit is unproved.");
  console.log(
    JSON.stringify({
      archivedWarmProof: {
        operationId,
        backupId,
        snapshotId: proof.snapshotId,
        captured,
        termination: warm.termination,
      },
    }),
  );
}
