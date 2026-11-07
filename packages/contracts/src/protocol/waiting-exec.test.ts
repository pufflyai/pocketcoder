import { expect, test } from "bun:test";
import { workloadLifecycle } from "../templates/workload-policy";
import { parseWorkloadTemplate, workloadSnapshotOf } from "../templates/workload-template";
import { waitingExecSpec } from "./waiting-exec";

test("waiting service sockets have writable memory when the authored root is read-only without tmp", async () => {
  const raw = await Bun.file(new URL("../../../../examples/workloads/finite-process.json", import.meta.url)).json();
  raw.spec.security = { readOnlyRoot: true, writableMemoryPaths: [] };
  const snapshot = workloadSnapshotOf(parseWorkloadTemplate(raw));
  const policy = workloadLifecycle(snapshot.manifest);
  expect(policy.security.writableMemoryPaths).toEqual(["/run/pocketcoder/services"]);
  expect(waitingExecSpec(snapshot, "runtime", "create").security.writable_memory_paths).toEqual(
    policy.security.writableMemoryPaths,
  );
});
