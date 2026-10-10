import { ADMISSION_ANNOTATION, hasNoPodAdmission } from "./kubernetes-empty-evidence";
import type { ContainerStatus, Resource } from "./kubernetes-evidence-types";

export const EVIDENCE_FINALIZER = "pocketcoder.dev/termination-evidence";
export const EVIDENCE_ANNOTATION = "pocketcoder.dev/termination-evidence";
const NODE_ANNOTATION = "pocketcoder.dev/termination-node";

type Command = (args: string[]) => Promise<string>;

async function patch(run: Command, kind: string, name: string, value: unknown) {
  await run(["patch", kind, name, "--type=merge", "-p", JSON.stringify(value)]);
}

async function podsFor(run: Command, name: string) {
  const result = JSON.parse(await run(["get", "pods", "-l", `job-name=${name}`, "-o", "json"])) as {
    items: Resource[];
  };
  return result.items;
}

function owned(pod: Resource, uid: string) {
  return pod.metadata.ownerReferences?.some((owner) => owner.uid === uid && owner.kind === "Job" && owner.controller);
}

function stopped(pod: Resource) {
  const groups = [
    [pod.spec.containers, pod.status?.containerStatuses],
    [pod.spec.initContainers, pod.status?.initContainerStatuses],
    [pod.spec.ephemeralContainers, pod.status?.ephemeralContainerStatuses],
  ] as const;
  if (!pod.spec.containers?.length) return false;
  // Kubernetes binding rejects deletionTimestamp: this Pod can no longer start.
  if (!pod.spec.nodeName && pod.metadata.deletionTimestamp) return groups.every(([, statuses]) => !statuses?.length);
  return groups.every(
    ([spec, statuses]) =>
      (spec?.length ?? 0) === (statuses?.length ?? 0) &&
      (spec ?? []).every((container) => {
        const status = statuses?.find((candidate) => candidate.name === container.name);
        return (
          status?.containerID &&
          status.state.terminated?.containerID === status.containerID &&
          !["ContainerStatusUnknown", "NodeLost"].includes(status.state.terminated?.reason ?? "") &&
          status.state.terminated?.finishedAt &&
          Number.isInteger(status.state.terminated.exitCode)
        );
      }),
  );
}

function podEvidence(pod: Resource) {
  // Never persist launch environment, volumes or delegated input in evidence.
  return {
    metadata: {
      uid: pod.metadata.uid,
      ownerReferences: pod.metadata.ownerReferences,
      deletionTimestamp: pod.metadata.deletionTimestamp,
    },
    spec: {
      nodeName: pod.spec.nodeName,
      containers: pod.spec.containers?.map(({ name }) => ({ name })),
      initContainers: pod.spec.initContainers?.map(({ name }) => ({ name })),
      ephemeralContainers: pod.spec.ephemeralContainers?.map(({ name }) => ({ name })),
    },
    status: {
      containerStatuses: statusEvidence(pod.status?.containerStatuses),
      initContainerStatuses: statusEvidence(pod.status?.initContainerStatuses),
      ephemeralContainerStatuses: statusEvidence(pod.status?.ephemeralContainerStatuses),
    },
  };
}

function statusEvidence(statuses: ContainerStatus[] | undefined) {
  return statuses?.map((status) => ({
    name: status.name,
    containerID: status.containerID,
    state: {
      terminated: {
        exitCode: status.state.terminated?.exitCode,
        finishedAt: status.state.terminated?.finishedAt,
        containerID: status.state.terminated?.containerID,
        reason: status.state.terminated?.reason,
      },
    },
  }));
}

async function updatePod<T>(run: Command, pod: Resource, update: (current: Resource) => Promise<T>): Promise<T> {
  const uid = pod.metadata.uid;
  const owner = pod.metadata.ownerReferences?.find((item) => item.kind === "Job" && item.controller)?.uid;
  for (let attempt = 0; ; attempt++) {
    try {
      return await update(pod);
    } catch (error) {
      if (attempt >= 4 || !(error instanceof Error) || !error.message.includes("Error from server (Conflict)"))
        throw error;
      // Kubelet and Job-controller status updates can race either finalizer
      // patch. Recompute from fresh metadata without overwriting their changes.
      await Bun.sleep(25 * (attempt + 1));
      pod = JSON.parse(await run(["get", "pod", pod.metadata.name as string, "-o", "json"])) as Resource;
      if (!uid || pod.metadata.uid !== uid || !owner || !owned(pod, owner))
        throw new Error("Termination provider changed");
    }
  }
}

async function retain(run: Command, pod: Resource) {
  return updatePod(run, pod, (current) => retainCurrent(run, current));
}

async function retainCurrent(run: Command, pod: Resource) {
  if (!pod.metadata.name || !pod.metadata.uid) throw new Error("Termination evidence unavailable");
  if (!pod.spec.nodeName) {
    await patch(run, "pod", pod.metadata.name, {
      metadata: {
        uid: pod.metadata.uid,
        resourceVersion: pod.metadata.resourceVersion,
        finalizers: [...new Set([...(pod.metadata.finalizers ?? []), EVIDENCE_FINALIZER])],
      },
    });
    return null;
  }
  const cached = pod.metadata.annotations?.[NODE_ANNOTATION];
  const node = cached
    ? (JSON.parse(cached) as Resource)
    : (JSON.parse(await run(["get", "node", pod.spec.nodeName, "-o", "json"])) as Resource);
  if (!node.metadata.uid || !node.spec.providerID) throw new Error("Termination node identity unavailable");
  const identity = {
    metadata: { uid: node.metadata.uid, deletionTimestamp: node.metadata.deletionTimestamp },
    spec: { providerID: node.spec.providerID },
    status: { conditions: node.status?.conditions?.filter((condition) => condition.type === "Ready") },
  };
  await patch(run, "pod", pod.metadata.name, {
    metadata: {
      uid: pod.metadata.uid,
      resourceVersion: pod.metadata.resourceVersion,
      finalizers: [...new Set([...(pod.metadata.finalizers ?? []), EVIDENCE_FINALIZER])],
      annotations: { [NODE_ANNOTATION]: JSON.stringify(identity) },
    },
  });
  return identity;
}

export async function retainNodeIdentities(run: Command, name: string, jobUid: string) {
  const pods = await podsFor(run, name);
  if (pods.some((pod) => !owned(pod, jobUid))) throw new Error("Termination provider changed");
  if (pods.length)
    await patch(run, "job", name, {
      metadata: { uid: jobUid, annotations: { [ADMISSION_ANNOTATION]: "true" } },
    });
  for (const pod of pods) {
    // Persist while the node exists; autoscaling can remove it before stop runs.
    if (pod.spec.nodeName && !pod.metadata.annotations?.[NODE_ANNOTATION]) await retain(run, pod);
  }
}

async function retainNodes(run: Command, pods: Resource[], nodes: Record<string, unknown>) {
  for (const pod of pods) {
    if (pod.spec.nodeName && nodes[pod.spec.nodeName] && pod.metadata.finalizers?.includes(EVIDENCE_FINALIZER))
      continue;
    const node = await retain(run, pod);
    if (pod.spec.nodeName) nodes[pod.spec.nodeName] = node;
  }
}

function matchingProof(job: Resource, uid: string) {
  const annotation = job.metadata.annotations?.[EVIDENCE_ANNOTATION];
  if (!annotation || job.metadata.uid !== uid) return false;
  const proof = JSON.parse(annotation) as { job?: { metadata?: { uid?: string } } };
  return proof.job?.metadata?.uid === uid;
}

async function retainedProof(run: Command, name: string, uid: string) {
  const output = await run(["get", "job", name, "--ignore-not-found", "-o", "json"]);
  return Boolean(output && matchingProof(JSON.parse(output) as Resource, uid));
}

function notFound(error: unknown) {
  return error instanceof Error && error.message.includes("Error from server (NotFound)");
}

async function releasePods(run: Command, name: string, jobUid: string) {
  for (const pod of await podsFor(run, name)) {
    if (!owned(pod, jobUid) || !pod.metadata.finalizers?.includes(EVIDENCE_FINALIZER)) continue;
    try {
      await updatePod(run, pod, (current) =>
        patch(run, "pod", current.metadata.name as string, {
          metadata: {
            uid: current.metadata.uid,
            resourceVersion: current.metadata.resourceVersion,
            finalizers: current.metadata.finalizers?.filter((item) => item !== EVIDENCE_FINALIZER) ?? [],
          },
        }),
      );
    } catch (error) {
      if (!notFound(error)) throw error;
      const current = await run(["get", "pod", pod.metadata.name as string, "--ignore-not-found", "-o", "json"]);
      if (current || !(await retainedProof(run, name, jobUid))) throw error;
    }
  }
}

async function stoppedJob(run: Command, name: string, uid: string, deadline: number): Promise<Resource> {
  while (true) {
    const job = JSON.parse(await run(["get", "job", name, "-o", "json"])) as Resource;
    if (job.metadata.uid !== uid) throw new Error("Termination provider changed");
    const conditions = job.status?.conditions ?? [];
    const terminal = conditions.some((item) => ["Complete", "Failed"].includes(item.type) && item.status === "True");
    const suspended =
      job.spec.suspend && conditions.some((item) => item.type === "Suspended" && item.status === "True");
    if (terminal || suspended) return job;
    if (Date.now() >= deadline) throw new Error("Job suspension unconfirmed");
    await Bun.sleep(100);
  }
}

export async function captureTermination(run: Command, name: string, graceSeconds: number) {
  const output = await run(["get", "job", name, "--ignore-not-found", "-o", "json"]);
  if (!output) throw new Error("Termination evidence unavailable");
  const job = JSON.parse(output) as Resource;
  if (!job.metadata.uid) throw new Error("Termination evidence unavailable");
  if (job.metadata.annotations?.[EVIDENCE_ANNOTATION]) {
    if (!matchingProof(job, job.metadata.uid)) throw new Error("Termination provider changed");
    await releasePods(run, name, job.metadata.uid);
    return;
  }
  try {
    await captureJobTermination(run, name, graceSeconds, job, job.metadata.uid);
  } catch (error) {
    const disappeared =
      error instanceof Error &&
      ["Termination provider disappeared without evidence", "Termination provider changed"].includes(error.message);
    if (!(notFound(error) || disappeared) || !(await retainedProof(run, name, job.metadata.uid))) throw error;
    await releasePods(run, name, job.metadata.uid);
  }
}

async function captureJobTermination(run: Command, name: string, graceSeconds: number, job: Resource, jobUid: string) {
  const initial = await podsFor(run, name);
  if (!initial.length) {
    if (await retainedProof(run, name, jobUid)) {
      await releasePods(run, name, jobUid);
      return;
    }
    if (!hasNoPodAdmission(job, EVIDENCE_FINALIZER)) throw new Error("Termination evidence unavailable");
  }
  if (initial.some((pod) => !owned(pod, jobUid))) throw new Error("Termination evidence unavailable");
  const nodes: Record<string, unknown> = {};
  await retainNodes(run, initial, nodes);
  await patch(run, "job", name, { metadata: { uid: job.metadata.uid }, spec: { suspend: true } });
  const confirmed = await stoppedJob(run, name, jobUid, Date.now() + (graceSeconds + 5) * 1000);
  if (!initial.length && !hasNoPodAdmission(confirmed, EVIDENCE_FINALIZER))
    throw new Error("Termination evidence unavailable");
  const retained = await podsFor(run, name);
  if (
    retained.length !== initial.length ||
    retained.some((pod) => !initial.some((old) => old.metadata.uid === pod.metadata.uid))
  )
    throw new Error("Termination provider changed");
  await run([
    "delete",
    "pod",
    "-l",
    `job-name=${name}`,
    `--grace-period=${graceSeconds}`,
    "--wait=false",
    "--ignore-not-found",
  ]);
  const deadline = Date.now() + (graceSeconds + 5) * 1000;
  while (true) {
    const pods = await podsFor(run, name);
    if (
      pods.length !== retained.length ||
      pods.some((pod) => !retained.some((old) => old.metadata.uid === pod.metadata.uid))
    )
      throw new Error("Termination provider disappeared without evidence");
    // Binding may have won the race with deletion after the initial snapshot.
    await retainNodes(run, pods, nodes);
    if (pods.every(stopped)) {
      const proof = {
        job: {
          metadata: { uid: job.metadata.uid, labels: job.metadata.labels },
          spec: {
            suspend: confirmed.spec.suspend,
            template: { metadata: { finalizers: confirmed.spec.template?.metadata?.finalizers } },
          },
          status: {
            conditions: confirmed.status?.conditions,
            active: confirmed.status?.active,
            ready: confirmed.status?.ready,
            terminating: confirmed.status?.terminating,
            succeeded: confirmed.status?.succeeded,
            failed: confirmed.status?.failed,
            uncountedTerminatedPods: confirmed.status?.uncountedTerminatedPods,
          },
        },
        pods: pods.map(podEvidence),
        nodes,
      };
      await patch(run, "job", name, {
        metadata: { uid: job.metadata.uid, annotations: { [EVIDENCE_ANNOTATION]: JSON.stringify(proof) } },
      });
      await releasePods(run, name, jobUid);
      return;
    }
    if (Date.now() >= deadline) throw new Error("Termination evidence unavailable");
    await Bun.sleep(100);
  }
}

export async function readTerminationEvidence(run: Command, name: string): Promise<Record<string, unknown> | null> {
  const output = await run(["get", "job", name, "--ignore-not-found", "-o", "json"]);
  if (!output) return null;
  const job = JSON.parse(output) as Resource;
  const value = job.metadata.annotations?.[EVIDENCE_ANNOTATION];
  return value ? (JSON.parse(value) as Record<string, unknown>) : null;
}
