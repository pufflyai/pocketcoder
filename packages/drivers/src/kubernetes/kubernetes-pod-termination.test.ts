import { expect, test } from "bun:test";
import type { Resource } from "./kubernetes-evidence-types";
import { podHasStopped, podTerminationProof } from "./kubernetes-pod-termination";

function canceledDuringInit(): Resource {
  return {
    metadata: { deletionTimestamp: "2026-11-20T11:25:51Z" },
    spec: {
      nodeName: "worker",
      restartPolicy: "Never",
      containers: [{ name: "workspace" }],
      initContainers: [{ name: "storage" }],
    },
    status: {
      phase: "Failed",
      containerStatuses: [
        { name: "workspace", restartCount: 0, started: false, state: { waiting: { reason: "PodInitializing" } } },
      ],
      initContainerStatuses: [
        {
          name: "storage",
          containerID: "containerd://init",
          state: {
            terminated: { containerID: "containerd://init", exitCode: 137, finishedAt: "2026-11-20T11:25:56Z" },
          },
        },
      ],
    },
  };
}

test("retains proof when cancellation stops init before the workload starts", () => {
  const pod = canceledDuringInit();
  expect(podHasStopped(pod)).toBe(true);
  expect(podHasStopped(podTerminationProof(pod))).toBe(true);
});

test("does not prove a waiting workload while init or an earlier workload can run", () => {
  const pod = canceledDuringInit();
  expect(podHasStopped({ ...pod, status: { ...pod.status, phase: "Pending" } })).toBe(false);
  expect(podHasStopped({ ...pod, metadata: {} })).toBe(false);
  const status = pod.status!.containerStatuses![0]!;
  status.restartCount = 1;
  expect(podHasStopped(pod)).toBe(false);
  status.restartCount = 0;
  status.containerID = "containerd://previous";
  expect(podHasStopped(pod)).toBe(false);
  delete status.containerID;
  pod.status!.initContainerStatuses![0]!.state = {};
  expect(podHasStopped(pod)).toBe(false);
});

test("termination proof omits provider diagnostic text", () => {
  const pod = canceledDuringInit();
  const status = pod.status!.containerStatuses![0]!;
  Object.assign(status.state.waiting!, { message: "private diagnostic" });
  status.lastState = { terminated: { message: "private diagnostic" } };
  const proof = podTerminationProof(pod);
  expect(JSON.stringify(proof)).not.toContain("private diagnostic");
  expect(podHasStopped(proof)).toBe(false);
});

test("requires a failed init that cannot restart before accepting waiting status", () => {
  const pod = canceledDuringInit();
  expect(podHasStopped({ ...pod, status: { ...pod.status, reason: "NodeLost" } })).toBe(false);
  expect(podHasStopped({ ...pod, spec: { ...pod.spec, restartPolicy: "OnFailure" } })).toBe(false);
  pod.spec.initContainers![0]!.restartPolicy = "Always";
  expect(podHasStopped(pod)).toBe(false);
  delete pod.spec.initContainers![0]!.restartPolicy;
  pod.status!.initContainerStatuses![0]!.state.terminated!.exitCode = 0;
  expect(podHasStopped(pod)).toBe(false);
});
