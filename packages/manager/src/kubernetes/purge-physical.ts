import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import type { PurgeAuthority } from "../purge/authority";
import type { PurgeIntent } from "../purge/intent";
import { namespaceForAccount } from "../purge/namespace-binding";
import {
  ControllerExits,
  ControllerInventory,
  PhysicalDeleted,
  PurgeDrain,
  VolumeInventory,
} from "../purge/physical-state";
import { createPurgeProgress } from "../purge/progress";
import type { PhysicalStorage } from "../purge/provider-types";
import type { kube } from "./command";
import { purgeController } from "./purge-controller";
import { purgeRuntimeDrain, verifyPurgeNodes } from "./purge-evidence";
import { privatePurgeRequest } from "./purge-private";
import { removePurgeRbac } from "./purge-rbac";
import { inventoryAccountVolumes, removeAccountVolumes } from "./purge-volumes";

type Target = { accountId: string; namespaceUid: string };
function requireExits(input: unknown, controllers: z.infer<typeof ControllerInventory>) {
  const proof = ControllerExits.parse(input);
  if (!isDeepStrictEqual(proof.pods.map((pod) => pod.uid).sort(), controllers.controllers.map((pod) => pod.uid).sort()))
    throw new Error("Retained controller termination is missing.");
  return proof;
}

async function removeNamespace(command: typeof kube, name: string, uid: string) {
  const current = await command(["get", "namespace", name, "--ignore-not-found", "-o", "json"]);
  if (!current) return;
  if (JSON.parse(current).metadata.uid !== uid) throw new Error("Account namespace identity changed.");
  await command(
    ["delete", "--raw", `/api/v1/namespaces/${name}`, "-f", "-"],
    JSON.stringify({
      apiVersion: "v1",
      kind: "DeleteOptions",
      preconditions: { uid },
      propagationPolicy: "Foreground",
    }),
  );
  const deadline = Date.now() + 30_000;
  for (;;) {
    const current = await command(["get", "namespace", name, "--ignore-not-found", "-o", "json"]);
    if (!current) return;
    if (JSON.parse(current).metadata.uid !== uid) throw new Error("Account namespace identity changed.");
    if (Date.now() >= deadline) throw new Error("Account namespace deletion is uncertain.");
    await Bun.sleep(100);
  }
}

export function physicalPurge(command: typeof kube, storage: PhysicalStorage, authority: PurgeAuthority) {
  return async (intent: PurgeIntent, target: Target) => {
    const account = { id: target.accountId, namespace: namespaceForAccount(target.accountId) };
    const progress = <T>(
      stage: "controllers" | "drained" | "stopped" | "inventory" | "deleted",
      schema: z.ZodType<T>,
    ) => createPurgeProgress(authority.dependencies, stage, schema, account.id);
    const controllers = await progress("controllers", ControllerInventory);
    const drained = await progress("drained", PurgeDrain);
    const stopped = await progress("stopped", ControllerExits);
    const inventory = await progress("inventory", VolumeInventory);
    const deleted = await progress("deleted", PhysicalDeleted);
    if (await deleted.acknowledge(intent)) return true;
    const controller = purgeController(command, account);
    const saved =
      (await controllers.acknowledge(intent)) ??
      (await controllers.retain(intent, await controller.inventory(target.namespaceUid)));
    if (saved.payload.namespaceUid !== target.namespaceUid) throw new Error("Retained purge namespace differs.");
    let drain = await drained.acknowledge(intent);
    if (!drain) {
      await controller.retain(saved.payload);
      const pod = saved.payload.controllers[0];
      if (!pod) throw new Error("Private account controller is missing.");
      const result = await privatePurgeRequest(command, account, pod.uid, intent.operationId);
      drain = await drained.retain(intent, purgeRuntimeDrain(result, account.id, intent.operationId));
      // Retain revocation and runtime exits before the next reconciliation stops the private controller.
      return false;
    }
    if (drain.payload.accountId !== account.id || drain.payload.operationId !== intent.operationId)
      throw new Error("Retained private purge identity differs.");
    const runtimeNodes = drain.payload.runtimes.flatMap((runtime) => runtime.pods.map((pod) => pod.node));
    await verifyPurgeNodes(command, runtimeNodes);
    let volumes = await inventory.acknowledge(intent);
    const exits = await stopped.acknowledge(intent);
    if (!volumes) {
      await controller.stop(saved.payload, exits?.payload ?? null, async (proof) => {
        await stopped.retain(intent, proof);
      });
      volumes = await inventory.retain(intent, await inventoryAccountVolumes(command, account, storage));
    }
    if (volumes.payload.namespaceUid !== target.namespaceUid || volumes.payload.accountId !== account.id)
      throw new Error("Retained physical purge inventory differs.");
    const exitProof = await stopped.acknowledge(intent);
    const terminated = requireExits(exitProof?.payload, saved.payload);
    const allNodes = [...runtimeNodes, ...terminated.pods.map((pod) => pod.node)];
    await verifyPurgeNodes(command, allNodes);
    const receipts = await removeAccountVolumes(command, volumes.payload, storage);
    await removePurgeRbac(command, account, saved.payload.rbac);
    await removeNamespace(command, account.namespace, target.namespaceUid);
    await verifyPurgeNodes(command, allNodes);
    await deleted.retain(intent, {
      namespaceUid: target.namespaceUid,
      volumes: receipts,
      rbac: saved.payload.rbac,
      endpoints: { scope: "shared", dnsIds: [], certificateIds: [] },
    });
    return true;
  };
}
