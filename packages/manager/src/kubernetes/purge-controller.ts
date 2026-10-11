import { isDeepStrictEqual } from "node:util";
import { type KubernetesEvidenceResource, podHasStopped } from "@pstdio/pocketcoder-drivers";
import { z } from "zod";
import { ControllerExits, ControllerInventory } from "../purge/physical-state";
import type { PurgeTarget } from "../purge/provider-types";
import type { kube } from "./command";
import { podNode, purgePodExit, verifyPurgeNodes } from "./purge-evidence";
import { inventoryPurgeRbac } from "./purge-rbac";

const finalizer = "pocketcoder.dev/controller-termination-evidence";
type Inventory = z.infer<typeof ControllerInventory>;
type Exits = z.infer<typeof ControllerExits>;

export function purgeController(command: typeof kube, target: PurgeTarget) {
  async function pods() {
    return JSON.parse(await command(["-n", target.namespace, "get", "pods", "-o", "json"]))
      .items as KubernetesEvidenceResource[];
  }
  async function deployment(uid?: string) {
    const value = JSON.parse(await command(["-n", target.namespace, "get", "deployment", "controller", "-o", "json"]));
    if (
      value.metadata.labels?.["pocketcoder.dev/account"] !== target.id ||
      !value.metadata.uid ||
      (uid && value.metadata.uid !== uid)
    )
      throw new Error("Purge controller deployment differs.");
    return value;
  }
  function bound(pod: KubernetesEvidenceResource, saved: Inventory) {
    const expected = saved.controllers.find((entry) => entry.uid === pod.metadata.uid);
    if (
      !expected ||
      pod.metadata.labels?.["pocketcoder.dev/account"] !== target.id ||
      pod.metadata.labels?.["pocketcoder.dev/role"] !== "controller" ||
      !pod.metadata.ownerReferences?.some(
        (owner) => owner.kind === "ReplicaSet" && owner.controller && owner.uid === expected.replicaSetUid,
      )
    )
      throw new Error("Purge controller Pod identity differs.");
    return expected;
  }
  async function patch(pod: KubernetesEvidenceResource, finalizers: string[]) {
    await command([
      "-n",
      target.namespace,
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
  async function inventory(namespaceUid: string) {
    const current = await deployment();
    const controllers = [];
    for (const pod of await pods()) {
      if (pod.metadata.labels?.["pocketcoder.dev/role"] !== "controller") continue;
      if (pod.metadata.labels?.["pocketcoder.dev/account"] !== target.id)
        throw new Error("Unknown controller remains.");
      const owner = pod.metadata.ownerReferences?.find((owner) => owner.kind === "ReplicaSet" && owner.controller);
      if (!owner) throw new Error("Controller ReplicaSet identity is missing.");
      const namedOwner = z.object({ name: z.string().min(1), uid: z.uuid() }).parse(owner);
      const rs = JSON.parse(
        await command(["-n", target.namespace, "get", "replicaset", namedOwner.name, "-o", "json"]),
      );
      if (
        rs.metadata.uid !== owner.uid ||
        rs.metadata.labels?.["pocketcoder.dev/account"] !== target.id ||
        !rs.metadata.ownerReferences?.some(
          (entry: { kind: string; uid: string; controller?: boolean }) =>
            entry.kind === "Deployment" && entry.controller && entry.uid === current.metadata.uid,
        )
      )
        throw new Error("Controller ReplicaSet ownership differs.");
      controllers.push({ uid: pod.metadata.uid, replicaSetUid: owner.uid, node: await podNode(command, pod) });
    }
    return ControllerInventory.parse({
      namespaceUid,
      deploymentUid: current.metadata.uid,
      controllers,
      rbac: await inventoryPurgeRbac(command, target),
    });
  }
  async function retain(saved: Inventory) {
    await deployment(saved.deploymentUid);
    const current = (await pods()).filter((pod) => pod.metadata.labels?.["pocketcoder.dev/role"] === "controller");
    if (current.length !== saved.controllers.length) throw new Error("Controller disappeared without exit proof.");
    for (const pod of current) {
      const expected = bound(pod, saved);
      if (!isDeepStrictEqual(await podNode(command, pod), expected.node))
        throw new Error("Controller placement changed.");
      await patch(pod, [...new Set([...(pod.metadata.finalizers ?? []), finalizer])]);
    }
    await verifyPurgeNodes(
      command,
      saved.controllers.map((entry) => entry.node),
    );
  }
  async function noJobs() {
    if (JSON.parse(await command(["-n", target.namespace, "get", "jobs", "-o", "json"])).items.length)
      throw new Error("Account jobs remain.");
  }
  async function capture(saved: Inventory, save: (proof: Exits) => Promise<void>) {
    await retain(saved);
    await noJobs();
    const current = await deployment(saved.deploymentUid);
    for (const pod of await pods()) bound(pod, saved);
    await command([
      "-n",
      target.namespace,
      "patch",
      "deployment",
      "controller",
      "--type=json",
      "-p",
      JSON.stringify([
        { op: "test", path: "/metadata/uid", value: current.metadata.uid },
        { op: "test", path: "/metadata/resourceVersion", value: current.metadata.resourceVersion },
        { op: "replace", path: "/spec/replicas", value: 0 },
      ]),
    ]);
    const deadline = Date.now() + 120_000;
    for (;;) {
      const current = await pods();
      if (current.length !== saved.controllers.length) throw new Error("Controller disappeared without exit proof.");
      for (const pod of current) bound(pod, saved);
      await verifyPurgeNodes(
        command,
        saved.controllers.map((entry) => entry.node),
      );
      if (current.every(podHasStopped)) {
        const proof = ControllerExits.parse({
          deploymentUid: saved.deploymentUid,
          pods: current.map((pod) => purgePodExit(pod, bound(pod, saved).node)),
        });
        await save(proof);
        return proof;
      }
      if (Date.now() >= deadline) throw new Error("Controller exit remains uncertain.");
      await Bun.sleep(100);
    }
  }
  function validateExits(saved: Inventory, proof: Exits) {
    if (
      proof.deploymentUid !== saved.deploymentUid ||
      proof.pods.length !== saved.controllers.length ||
      proof.pods.some(
        (pod) => !saved.controllers.some((entry) => entry.uid === pod.uid && isDeepStrictEqual(entry.node, pod.node)),
      )
    )
      throw new Error("Retained controller exit identity differs.");
  }
  async function release(saved: Inventory, proof: Exits) {
    validateExits(saved, proof);
    const current = await deployment(saved.deploymentUid);
    if (current.spec.replicas !== 0) throw new Error("Controller can still start.");
    await verifyPurgeNodes(
      command,
      proof.pods.map((pod) => pod.node),
    );
    for (const pod of await pods()) {
      const expected = bound(pod, saved);
      if (
        !isDeepStrictEqual(
          purgePodExit(pod, expected.node),
          proof.pods.find((entry) => entry.uid === expected.uid),
        )
      )
        throw new Error("Retained controller exit changed.");
      await patch(
        pod,
        (pod.metadata.finalizers ?? []).filter((entry) => entry !== finalizer),
      );
    }
    const deadline = Date.now() + 120_000;
    while ((await pods()).length) {
      if (Date.now() >= deadline) throw new Error("Account controller remains.");
      await Bun.sleep(100);
    }
    await noJobs();
    await verifyPurgeNodes(
      command,
      proof.pods.map((pod) => pod.node),
    );
    return proof;
  }
  async function stop(saved: Inventory, existing: Exits | null, save: (proof: Exits) => Promise<void>) {
    return release(saved, existing ?? (await capture(saved, save)));
  }
  return { inventory, retain, stop };
}
