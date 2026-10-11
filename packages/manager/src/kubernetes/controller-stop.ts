import { type KubernetesEvidenceResource, podHasStopped, podTerminationProof } from "@pstdio/pocketcoder-drivers";
import type { Account, ManagerStore } from "../database/store";
import type { kube } from "./command";

const finalizer = "pocketcoder.dev/controller-termination-evidence";
type Operation = NonNullable<Awaited<ReturnType<ManagerStore["getOperation"]>>>;
type Expected = { name: string; uid: string; node: string | null };

export function controllerStop(command: typeof kube) {
  async function pods(account: Account) {
    const response = JSON.parse(await command(["-n", account.namespace, "get", "pods", "-o", "json"])) as {
      items: KubernetesEvidenceResource[];
    };
    return response.items;
  }
  function controller(account: Account, pod: KubernetesEvidenceResource) {
    if (
      pod.metadata.labels?.["pocketcoder.dev/account"] !== account.id ||
      pod.metadata.labels?.["pocketcoder.dev/role"] !== "controller" ||
      !pod.metadata.ownerReferences?.some((owner) => owner.kind === "ReplicaSet")
    )
      throw new Error("Unknown account compute remains.");
    if (!pod.metadata.uid || !pod.metadata.name) throw new Error("Controller identity is missing.");
    return { name: pod.metadata.name, uid: pod.metadata.uid, node: pod.spec.nodeName ?? null };
  }
  async function patch(account: Account, pod: KubernetesEvidenceResource, finalizers: string[]) {
    await command([
      "-n",
      account.namespace,
      "patch",
      "pod",
      pod.metadata.name as string,
      "--type=merge",
      "-p",
      JSON.stringify({
        metadata: { uid: pod.metadata.uid, resourceVersion: pod.metadata.resourceVersion, finalizers },
      }),
    ]);
  }
  async function retain(account: Account, current: KubernetesEvidenceResource[], expected: Expected[]) {
    for (const wanted of expected) {
      const pod = current.find((candidate) => candidate.metadata.uid === wanted.uid);
      if (!pod) throw new Error("Controller disappeared without termination evidence.");
      await patch(account, pod, [...new Set([...(pod.metadata.finalizers ?? []), finalizer])]);
    }
  }
  async function waitStopped(account: Account, expected: Expected[]) {
    const deadline = Date.now() + 120_000;
    for (;;) {
      const remaining = await pods(account);
      if (
        remaining.length !== expected.length ||
        remaining.some((pod) => !expected.some((wanted) => wanted.uid === pod.metadata.uid))
      )
        throw new Error("Controller termination identity changed.");
      if (remaining.every(podHasStopped)) return remaining.map(podTerminationProof);
      if (Date.now() >= deadline) throw new Error("Controller termination remains uncertain.");
      await Bun.sleep(100);
    }
  }
  async function release(account: Account, expected: Expected[]) {
    for (const pod of await pods(account)) {
      if (!expected.some((wanted) => wanted.uid === pod.metadata.uid))
        throw new Error("Unknown account compute remains.");
      if (!podHasStopped(pod)) throw new Error("Controller termination remains uncertain.");
      await patch(
        account,
        pod,
        (pod.metadata.finalizers ?? []).filter((item) => item !== finalizer),
      );
    }
    const deadline = Date.now() + 120_000;
    while ((await pods(account)).length) {
      if (Date.now() >= deadline) throw new Error("Account compute remains.");
      await Bun.sleep(100);
    }
    const jobs = JSON.parse(await command(["-n", account.namespace, "get", "jobs", "-o", "json"])) as {
      items: unknown[];
    };
    if (jobs.items.length) throw new Error("Account jobs remain.");
  }
  async function prepare(account: Account, operation: Operation, store: ManagerStore) {
    const current = await pods(account);
    const proof = operation.computeProof ?? {};
    if (proof.controllerTermination) return;
    const expected = (proof.expectedControllers ?? []) as Expected[];
    for (const pod of current) {
      // Runtime Pods are still live here; the core drains them before stop enforces the full inventory.
      if (pod.metadata.labels?.["pocketcoder.dev/role"] !== "controller") continue;
      const identity = controller(account, pod);
      if (!expected.some((item) => item.uid === identity.uid)) expected.push(identity);
    }
    if (!expected.length) throw new Error("Controller disappeared without termination evidence.");
    await store.saveComputeProof(operation.id, { ...proof, expectedControllers: expected });
    await retain(account, current, expected);
  }
  async function stop(account: Account, operation: Operation, store: ManagerStore) {
    const current = await pods(account);
    const proof = operation.computeProof ?? {};
    let expected = proof.expectedControllers as Expected[] | undefined;
    if (!expected) {
      if (!current.length) throw new Error("Controller disappeared without termination evidence.");
      expected = current.map((pod) => controller(account, pod));
      await store.saveComputeProof(operation.id, { ...proof, expectedControllers: expected });
    }
    if (!proof.controllerTermination) {
      await retain(account, current, expected);
      await command(["-n", account.namespace, "scale", "deployment/controller", "--replicas=0"]);
      const controllerTermination = await waitStopped(account, expected);
      await store.saveComputeProof(operation.id, { ...proof, expectedControllers: expected, controllerTermination });
    }
    await release(account, expected);
  }
  return { prepare, stop };
}
