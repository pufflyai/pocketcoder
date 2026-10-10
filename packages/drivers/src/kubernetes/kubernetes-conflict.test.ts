import { expect, test } from "bun:test";
import { retainNodeIdentities } from "./kubernetes-evidence";

test.each([
  { mode: "replacement", error: "Termination provider changed", patches: 1, reads: 1 },
  { mode: "persistent", error: "Conflict", patches: 5, reads: 4 },
  { mode: "forbidden", error: "Forbidden", patches: 1, reads: 0 },
])("pod metadata retry fails closed: %j", async (expected) => {
  const { mode } = expected;
  const pod = {
    metadata: {
      name: "pod",
      uid: "original",
      resourceVersion: "1",
      finalizers: [],
      ownerReferences: [{ kind: "Job", uid: "job", controller: true }],
    },
    spec: { nodeName: "node" },
  };
  let patches = 0;
  let reads = 0;
  const run = async (args: string[]) => {
    const command = args.slice(0, 2).join(" ");
    if (command === "get pods") return JSON.stringify({ items: [pod] });
    if (command === "get pod") {
      reads++;
      return JSON.stringify({
        ...pod,
        metadata: { ...pod.metadata, uid: mode === "replacement" ? "other" : "original" },
      });
    }
    if (command === "get node")
      return JSON.stringify({ metadata: { uid: "node" }, spec: { providerID: "aws:///zone/instance" } });
    if (command === "patch job") {
      const patch = JSON.parse(args[args.indexOf("-p") + 1] as string);
      expect(patch.metadata.uid).toBe("job");
      expect(patch.metadata.annotations["pocketcoder.dev/pod-admitted"]).toBe("true");
      return "";
    }
    if (command === "patch pod") {
      patches++;
      throw new Error(`Error from server (${mode === "forbidden" ? "Forbidden" : "Conflict"})`);
    }
    throw new Error("Unexpected command");
  };
  await expect(retainNodeIdentities(run, "job", "job")).rejects.toThrow(expected.error);
  expect(patches).toBe(expected.patches);
  expect(reads).toBe(expected.reads);
});
