import type { ContainerStatus, Resource } from "./kubernetes-evidence-types";

export function podHasStopped(pod: Resource) {
  const initStopped =
    (pod.spec.initContainers?.length ?? 0) > 0 &&
    (pod.spec.initContainers ?? []).every((container) =>
      terminated(pod.status?.initContainerStatuses?.find((s) => s.name === container.name)),
    );
  const canceledBeforeStart = Boolean(
    pod.metadata.deletionTimestamp && pod.status?.phase === "Failed" && initStopped && failedInitPreventsStartup(pod),
  );
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
        if (terminated(status)) return true;
        // Kubelet keeps never-started workload containers waiting after init cancellation.
        return (
          spec === pod.spec.containers &&
          canceledBeforeStart &&
          status?.state.waiting?.reason === "PodInitializing" &&
          !status.containerID &&
          status.started === false &&
          status.restartCount === 0 &&
          !status.lastState?.terminated
        );
      }),
  );
}

export function podTerminationProof(pod: Resource) {
  // Never persist launch environment, volumes or delegated input in evidence.
  return {
    metadata: {
      uid: pod.metadata.uid,
      ownerReferences: pod.metadata.ownerReferences,
      deletionTimestamp: pod.metadata.deletionTimestamp,
    },
    spec: {
      nodeName: pod.spec.nodeName,
      restartPolicy: pod.spec.restartPolicy,
      containers: pod.spec.containers?.map(({ name }) => ({ name })),
      initContainers: pod.spec.initContainers?.map(({ name, restartPolicy }) => ({ name, restartPolicy })),
      ephemeralContainers: pod.spec.ephemeralContainers?.map(({ name }) => ({ name })),
    },
    status: {
      phase: pod.status?.phase,
      reason: pod.status?.reason,
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
    restartCount: status.restartCount,
    started: status.started,
    lastState: status.lastState?.terminated ? { terminated: {} } : undefined,
    state: {
      waiting: status.state.waiting ? { reason: status.state.waiting.reason } : undefined,
      terminated: status.state.terminated
        ? {
            exitCode: status.state.terminated.exitCode,
            finishedAt: status.state.terminated.finishedAt,
            containerID: status.state.terminated.containerID,
            reason: status.state.terminated.reason,
          }
        : undefined,
    },
  }));
}

function terminated(status: ContainerStatus | undefined) {
  const exit = status?.state.terminated;
  return Boolean(
    status?.containerID &&
      exit?.containerID === status.containerID &&
      !["ContainerStatusUnknown", "NodeLost"].includes(exit.reason ?? "") &&
      exit.finishedAt &&
      Number.isInteger(exit.exitCode),
  );
}

function failedInitPreventsStartup(pod: Resource) {
  if (pod.spec.restartPolicy !== "Never" || pod.status?.reason) return false;
  // A failed, non-restartable init prevents regular startup even if PodGC marks stale status Failed.
  return (pod.spec.initContainers ?? []).some((init) => {
    const status = pod.status?.initContainerStatuses?.find((s) => s.name === init.name);
    return init.restartPolicy === undefined && terminated(status) && status?.state.terminated?.exitCode !== 0;
  });
}
