import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { ManagerError } from "../accounts/errors";
import type { Account } from "../database/store";
import type { kube } from "../kubernetes/command";
import { privateControllerRequest } from "../kubernetes/private-controller";
import { ControllerFormatSchema, type Release } from "./releases";

const Status = z.strictObject({ data: ControllerFormatSchema, agentProtocol: z.number().int().positive() });
export function kubernetesUpgrade(command: typeof kube) {
  async function deployment(account: Account) {
    const value = JSON.parse(await command(["-n", account.namespace, "get", "deployment", "controller", "-o", "json"]));
    if (value.metadata.labels?.["pocketcoder.dev/account"] !== account.id)
      throw new Error("Upgrade controller identity differs.");
    return value;
  }
  async function format(account: Account, release: Release) {
    const current = await deployment(account);
    const containers = [...current.spec.template.spec.containers, ...current.spec.template.spec.initContainers];
    if (containers.some((container) => container.image !== release.controllerImage))
      throw new Error("Upgrade controller image differs.");
    const actual = Status.parse(await privateControllerRequest(command, account, "/v1/release"));
    if (!isDeepStrictEqual(actual.data, release.data) || actual.agentProtocol !== release.agentProtocol)
      throw new Error("Upgrade controller engine, schema or agent protocol differs.");
  }
  return {
    format,
    async requireRecoveryCapacity(account: Account) {
      const inventory = JSON.parse(await command(["-n", account.namespace, "get", "pvc", "-o", "json"]));
      const current = inventory.items.find(
        (volume: { metadata: { name: string } }) => volume.metadata.name === account.volumeName,
      );
      if (current?.metadata.labels?.["pocketcoder.dev/account"] !== account.id)
        throw new ManagerError(409, "upgrade_volume_identity");
      if (inventory.items.length >= 2) throw new ManagerError(409, "upgrade_recovery_capacity");
    },
    async install(account: Account, release: Release, operationId: string) {
      const current = await deployment(account);
      if (
        current.spec.replicas !== 0 &&
        current.spec.template.metadata.annotations?.["pocketcoder.dev/upgrade-operation"] !== operationId
      )
        throw new Error("Upgrade controller is not stopped.");
      const images = (containers: { name: string; image: string }[]) =>
        containers.map((container) => ({ ...container, image: release.controllerImage }));
      // Update and Apply have separate ownership, even with the same manager name.
      // Keep image ownership on Apply so fresh-volume recovery can change it later.
      await command(
        ["apply", "--server-side", "--field-manager=pocketcoder-manager", "-f", "-"],
        JSON.stringify({
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: {
            name: "controller",
            namespace: account.namespace,
            labels: current.metadata.labels,
            uid: current.metadata.uid,
            resourceVersion: current.metadata.resourceVersion,
          },
          spec: {
            ...current.spec,
            replicas: 1,
            template: {
              ...current.spec.template,
              metadata: {
                ...current.spec.template.metadata,
                annotations: {
                  ...current.spec.template.metadata.annotations,
                  "pocketcoder.dev/upgrade-operation": operationId,
                },
              },
              spec: {
                ...current.spec.template.spec,
                containers: images(current.spec.template.spec.containers),
                initContainers: images(current.spec.template.spec.initContainers),
              },
            },
          },
        }),
      );
      await command(["-n", account.namespace, "rollout", "status", "deployment/controller", "--timeout=120s"]);
    },
    async verify(account: Account, release: Release) {
      await format(account, release);
      const status = z
        .object({ state: z.literal("suspended"), operation_state: z.literal("succeeded") })
        .parse(await privateControllerRequest(command, account, "/v1/account/verify", {}));
      return status;
    },
  };
}
