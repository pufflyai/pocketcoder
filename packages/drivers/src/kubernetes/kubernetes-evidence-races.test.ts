import { expect, test } from "bun:test";
import { captureTermination, EVIDENCE_ANNOTATION, EVIDENCE_FINALIZER } from "./kubernetes-evidence";

test.each(["matching", "absent", "wrong-proof", "replacement"] as const)(
  "an empty initial Pod snapshot requires %s retained Job proof",
  async (identity) => {
    let jobReads = 0;
    const run = async (args: string[]) => {
      if (args[0] === "get" && args[1] === "pods") return JSON.stringify({ items: [] });
      if (args[0] === "get" && args[1] === "job") {
        jobReads++;
        const proof = { job: { metadata: { uid: identity === "wrong-proof" ? "other" : "original" } } };
        return JSON.stringify({
          metadata: {
            uid: jobReads > 1 && identity === "replacement" ? "replacement" : "original",
            annotations: jobReads > 1 && identity !== "absent" ? { [EVIDENCE_ANNOTATION]: JSON.stringify(proof) } : {},
          },
        });
      }
      throw new Error(`Unexpected command ${args}`);
    };
    if (identity === "matching") await expect(captureTermination(run, "job", 1)).resolves.toBeUndefined();
    else await expect(captureTermination(run, "job", 1)).rejects.toThrow("Termination evidence unavailable");
  },
);

test("a missing Job cannot supply termination proof", async () => {
  await expect(captureTermination(async () => "", "missing", 1)).rejects.toThrow("Termination evidence unavailable");
});

test("a retained annotation for another Job UID is rejected", async () => {
  const run = async () =>
    JSON.stringify({
      metadata: {
        uid: "replacement",
        annotations: { [EVIDENCE_ANNOTATION]: JSON.stringify({ job: { metadata: { uid: "original" } } }) },
      },
    });
  await expect(captureTermination(run, "job", 1)).rejects.toThrow("Termination provider changed");
});

test.each(["matching", "absent", "wrong-job"] as const)(
  "Pod removal during evidence capture requires %s retained proof",
  async (proofState) => {
    const job = { metadata: { uid: "job-uid", annotations: {} as Record<string, string> } };
    const proof = {
      job: { metadata: { uid: proofState === "wrong-job" ? "other" : "job-uid" } },
      pods: [{ metadata: { uid: "pod-uid" } }],
    };
    let removed = false;
    const run = async (args: string[]) => {
      if (args[0] === "get" && args[1] === "job") return JSON.stringify(job);
      if (args[0] === "get" && args[1] === "pods")
        return JSON.stringify({
          items: removed
            ? []
            : [
                {
                  metadata: {
                    name: "pod",
                    uid: "pod-uid",
                    ownerReferences: [{ uid: "job-uid", kind: "Job", controller: true }],
                  },
                  spec: {},
                },
              ],
        });
      if (args[0] === "patch" && args[1] === "pod") {
        removed = true;
        if (proofState !== "absent") job.metadata.annotations[EVIDENCE_ANNOTATION] = JSON.stringify(proof);
        throw new Error('Error from server (NotFound): pods "pod" not found');
      }
      throw new Error(`Unexpected command ${args}`);
    };
    if (proofState === "matching") await expect(captureTermination(run, "job", 1)).resolves.toBeUndefined();
    else await expect(captureTermination(run, "job", 1)).rejects.toThrow("NotFound");
  },
);

test.each(["matching", "absent", "replacement"] as const)(
  "removing an already-proved Pod finalizer requires %s identity",
  async (identity) => {
    let deleted = false;
    const proof = { job: { metadata: { uid: "job-uid" } }, pods: [{ metadata: { uid: "pod-uid" } }] };
    const run = async (args: string[]) => {
      const currentUid = identity === "replacement" && deleted ? "other-job" : "job-uid";
      const annotations = identity === "absent" && deleted ? {} : { [EVIDENCE_ANNOTATION]: JSON.stringify(proof) };
      if (args[0] === "get" && args[1] === "job")
        return JSON.stringify({
          metadata: {
            uid: currentUid,
            annotations,
          },
        });
      if (args[0] === "get" && args[1] === "pods")
        return JSON.stringify({
          items: deleted
            ? []
            : [
                {
                  metadata: {
                    name: "pod",
                    uid: "pod-uid",
                    finalizers: [EVIDENCE_FINALIZER],
                    ownerReferences: [{ uid: "job-uid", kind: "Job", controller: true }],
                  },
                  spec: {},
                },
              ],
        });
      if (args[0] === "patch") {
        deleted = true;
        throw new Error("Error from server (NotFound)");
      }
      if (args[0] === "get" && args[1] === "pod") return "";
      throw new Error(`Unexpected command ${args}`);
    };
    if (identity === "matching") await expect(captureTermination(run, "job", 1)).resolves.toBeUndefined();
    else await expect(captureTermination(run, "job", 1)).rejects.toThrow();
  },
);
