import { expect, test } from "bun:test";
import { captureTermination, EVIDENCE_ANNOTATION, EVIDENCE_FINALIZER } from "./kubernetes-evidence";

test.each([
  { crash: false, conflict: "none" },
  { crash: true, conflict: "none" },
  { crash: false, conflict: "retain" },
  { crash: false, conflict: "release" },
])("termination evidence survives concurrent pod updates (%j)", async ({ crash, conflict }) => {
  // Kubernetes command boundary; exercise the capture protocol without a cluster.
  const job = {
    metadata: {
      uid: "job-uid",
      resourceVersion: "1",
      annotations: {} as Record<string, string>,
      labels: { "pocketcoder.workspace": "generation" },
    },
    spec: { suspend: false },
    status: { conditions: [] as { type: string; status: string }[] },
  };
  const pod = {
    metadata: {
      name: "pod",
      uid: "pod-uid",
      resourceVersion: "1",
      annotations: {} as Record<string, string>,
      finalizers: [] as string[],
      ownerReferences: [{ uid: "job-uid", kind: "Job", controller: true }],
    },
    spec: { nodeName: "node", containers: [{ name: "runner" }] },
    status: {
      containerStatuses: [{ name: "runner", containerID: "containerd://runner", state: {} as Record<string, unknown> }],
    },
  };
  const commands: string[][] = [];
  let conflicted = false;
  const applyPatch = (resource: string | undefined, args: string[]) => {
    const patch = JSON.parse(args[args.indexOf("-p") + 1] ?? "{}");
    if (resource === "job") {
      Object.assign(job.spec, patch.spec ?? {});
      if (patch.spec?.suspend) job.status.conditions = [{ type: "Suspended", status: "True" }];
      Object.assign(job.metadata.annotations, patch.metadata?.annotations ?? {});
      if (crash && patch.metadata?.annotations?.[EVIDENCE_ANNOTATION]) throw new Error("crash after durable proof");
      return;
    }
    const retaining = patch.metadata?.finalizers?.includes(EVIDENCE_FINALIZER);
    if (!conflicted && conflict === (retaining ? "retain" : "release")) {
      conflicted = true;
      pod.metadata.resourceVersion = "2";
      pod.metadata.finalizers.push("other-controller/hold");
      throw new Error("kubectl patch failed (1): Error from server (Conflict): object has been modified");
    }
    expect(patch.metadata.resourceVersion).toBe(pod.metadata.resourceVersion);
    if (!retaining) expect(job.metadata.annotations[EVIDENCE_ANNOTATION]).toBeDefined();
    Object.assign(pod.metadata, patch.metadata);
  };
  const run = async (args: string[]) => {
    commands.push(args);
    const [verb, resource] = args;
    if (verb === "get" && resource === "job") return JSON.stringify(job);
    if (verb === "get" && resource === "pods") return JSON.stringify({ items: [pod] });
    if (verb === "get" && resource === "pod") return JSON.stringify(pod);
    if (verb === "get" && resource === "node")
      return JSON.stringify({
        metadata: { uid: "node-uid" },
        spec: { providerID: "aws:///eu-north-1a/i-0123456789abcdef0" },
      });
    if (verb === "patch") {
      applyPatch(resource, args);
      return "";
    }
    if (verb === "delete") {
      expect(pod.metadata.finalizers).toContain(EVIDENCE_FINALIZER);
      const status = pod.status.containerStatuses[0];
      if (!status) throw new Error("Missing synthetic container");
      status.state = {
        terminated: {
          exitCode: 0,
          finishedAt: "2026-09-17T12:00:00Z",
          containerID: "containerd://runner",
          reason: "Completed",
        },
      };
      return "";
    }
    throw new Error(`Unexpected provider command ${args.join(" ")}`);
  };
  if (crash) {
    await expect(captureTermination(run, "job", 1, "job-uid", "default")).rejects.toThrow("crash after durable proof");
    expect(pod.metadata.finalizers).toContain(EVIDENCE_FINALIZER);
  }
  await captureTermination(run, "job", 1, "job-uid", "default");
  const proof = JSON.parse(job.metadata.annotations[EVIDENCE_ANNOTATION] ?? "null");
  expect(proof.job.metadata.uid).toBe("job-uid");
  expect(proof.job.status.conditions).toContainEqual({ type: "Suspended", status: "True" });
  expect(proof.pods[0].status.containerStatuses[0].state.terminated.exitCode).toBe(0);
  expect(proof.pods[0].status.containerStatuses[0].state.terminated.containerID).toBe("containerd://runner");
  expect(pod.metadata.finalizers).not.toContain(EVIDENCE_FINALIZER);
  if (conflict !== "none") {
    expect(conflicted).toBe(true);
    expect(pod.metadata.finalizers).toContain("other-controller/hold");
  }
  const count = commands.length;
  await captureTermination(run, "job", 1, "job-uid", "default");
  expect(commands.slice(count).some((args) => args[0] === "delete")).toBe(false);
});

test("missing Pods never generate termination evidence", async () => {
  const run = async (args: string[]) => {
    if (args[1] === "job") return JSON.stringify({ metadata: { uid: "job", annotations: {} } });
    return JSON.stringify({ items: [] });
  };
  await expect(captureTermination(run, "job", 1, "job", "default")).rejects.toThrow("Termination evidence unavailable");
});
