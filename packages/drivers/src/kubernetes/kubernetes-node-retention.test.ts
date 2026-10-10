import { expect, test } from "bun:test";
import { retainNodeIdentities } from "./kubernetes-evidence";

test("provider inspection retains node identity before termination and survives node deletion", async () => {
  const pod = {
    metadata: {
      name: "pod",
      uid: "pod-uid",
      resourceVersion: "1",
      ownerReferences: [{ uid: "job-uid", kind: "Job", controller: true }],
      annotations: {} as Record<string, string>,
    },
    spec: { nodeName: "node" },
  };
  let deleted = false;
  let reads = 0;
  const run = async (args: string[]) => {
    if (args[0] === "get" && args[1] === "pods") return JSON.stringify({ items: [pod] });
    if (args[0] === "get" && args[1] === "node") {
      reads++;
      if (deleted) throw new Error("Node NotFound");
      return JSON.stringify({ metadata: { uid: "node-uid" }, spec: { providerID: "aws:///eu-north-1a/i-123" } });
    }
    if (args[0] === "patch" && args[1] === "job") {
      const patch = JSON.parse(args[args.indexOf("-p") + 1] as string);
      expect(patch.metadata.uid).toBe("job-uid");
      expect(patch.metadata.annotations["pocketcoder.dev/pod-admitted"]).toBe("true");
      return "";
    }
    if (args[0] === "patch" && args[1] === "pod") {
      const patch = JSON.parse(args[args.indexOf("-p") + 1] as string);
      expect(patch.metadata.uid).toBe("pod-uid");
      expect(patch.metadata.resourceVersion).toBe("1");
      Object.assign(pod.metadata, patch.metadata);
      return "";
    }
    throw new Error("Unexpected command");
  };
  await retainNodeIdentities(run, "job", "job-uid");
  const cached = JSON.parse(pod.metadata.annotations["pocketcoder.dev/termination-node"] as string);
  expect(cached.metadata.uid).toBe("node-uid");
  expect(cached.spec.providerID).toBe("aws:///eu-north-1a/i-123");
  deleted = true;
  await retainNodeIdentities(run, "job", "job-uid");
  expect(reads).toBe(1);
});

test("inspection skips unscheduled Pods and rejects another Job's Pods", async () => {
  let owner = "job-uid";
  const run = async (args: string[]) => {
    if (args[0] === "patch") {
      expect(args.slice(0, 2)).toEqual(["patch", "job"]);
      return "";
    }
    expect(args.slice(0, 2)).toEqual(["get", "pods"]);
    return JSON.stringify({
      items: [{ metadata: { uid: "pod", ownerReferences: [{ uid: owner, kind: "Job", controller: true }] }, spec: {} }],
    });
  };
  await retainNodeIdentities(run, "job", "job-uid");
  owner = "other-job";
  await expect(retainNodeIdentities(run, "job", "job-uid")).rejects.toThrow("Termination provider changed");
});
