import { expect, test } from "bun:test";
import { captureTermination, EVIDENCE_ANNOTATION, EVIDENCE_FINALIZER } from "./kubernetes-evidence";

test.each([false, true])("pending cancellation captures binding race safely (bound=%s)", async (bound) => {
  // Kubernetes API boundary: binding can win before deletion, never after it.
  const job = {
    metadata: { uid: "job", annotations: {} as Record<string, string> },
    spec: { suspend: false },
    status: { conditions: [] as { type: string; status: string }[] },
  };
  const pod = {
    metadata: {
      name: "pod",
      uid: "pod",
      resourceVersion: "1",
      deletionTimestamp: undefined as string | undefined,
      finalizers: [EVIDENCE_FINALIZER],
      annotations: {} as Record<string, string>,
      ownerReferences: [{ uid: "job", kind: "Job", controller: true }],
    },
    spec: { nodeName: undefined as string | undefined, containers: [{ name: "runner" }] },
    status: {} as Record<string, unknown>,
  };
  const applyPatch = (args: string[]) => {
    const patch = JSON.parse(args[args.indexOf("-p") + 1] as string);
    if (args[1] === "job") {
      Object.assign(job.metadata.annotations, patch.metadata?.annotations ?? {});
      if (patch.spec?.suspend) {
        job.spec.suspend = true;
        job.status.conditions = [{ type: "Suspended", status: "True" }];
        if (bound) pod.spec.nodeName = "node";
      }
    } else {
      if (patch.metadata.finalizers && !patch.metadata.finalizers.includes(EVIDENCE_FINALIZER))
        expect(job.metadata.annotations[EVIDENCE_ANNOTATION]).toBeDefined();
      Object.assign(pod.metadata, patch.metadata);
    }
    return "";
  };
  const run = async (args: string[]) => {
    if (args[0] === "get" && args[1] === "job") return JSON.stringify(job);
    if (args[0] === "get" && args[1] === "pods") return JSON.stringify({ items: [pod] });
    if (args[0] === "get" && args[1] === "node")
      return JSON.stringify({ metadata: { uid: "node" }, spec: { providerID: "aws:///eu-north-1a/i-123" } });
    if (args[0] === "patch") return applyPatch(args);
    if (args[0] === "delete") {
      pod.metadata.deletionTimestamp = "2026-09-18T12:00:00Z";
      if (bound)
        pod.status = {
          containerStatuses: [
            {
              name: "runner",
              containerID: "containerd://runner",
              state: {
                terminated: { exitCode: 0, finishedAt: "2026-09-18T12:00:00Z", containerID: "containerd://runner" },
              },
            },
          ],
        };
      return "";
    }
    throw new Error("Unexpected command");
  };
  await captureTermination(run, "job", 1, "job", "default");
  const proof = JSON.parse(job.metadata.annotations[EVIDENCE_ANNOTATION] as string);
  expect(proof.pods[0].metadata.deletionTimestamp).toBeDefined();
  expect(Object.keys(proof.nodes)).toEqual(bound ? ["node"] : []);
  expect(pod.metadata.finalizers).not.toContain(EVIDENCE_FINALIZER);
});
