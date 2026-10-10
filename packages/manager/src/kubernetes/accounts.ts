import { z } from "zod";
import type { Account, ManagerStore } from "../database/store";
import { kube } from "./command";
import { accountManifests } from "./manifests";

const OwnerResult = z
  .object({ token: z.string().nullable(), key: z.object({ id: z.uuid() }).passthrough() })
  .passthrough();
export class KubernetesAccounts {
  async ensure(account: Account) {
    await kube(["get", "runtimeclass", account.plan.runtimeClassName, "-o", "name"]);
    const cni = JSON.parse(await kube(["-n", "kube-system", "get", "daemonset", "calico-node", "-o", "json"]));
    if (!cni.status.desiredNumberScheduled || cni.status.numberReady !== cni.status.desiredNumberScheduled)
      throw new Error("Calico enforcement is not ready");
    const endpoints = JSON.parse(
      await kube([
        "-n",
        "default",
        "get",
        "endpointslices",
        "-l",
        "kubernetes.io/service-name=kubernetes",
        "-o",
        "json",
      ]),
    );
    const addresses: string[] = endpoints.items.flatMap((slice: { endpoints: { addresses: string[] }[] }) =>
      slice.endpoints.flatMap((e) => e.addresses),
    );
    if (!addresses.length) throw new Error("Kubernetes API destinations missing");
    const resources = accountManifests(account, addresses);
    for (const resource of resources) {
      const args = ["get", resource.kind, resource.metadata.name, "--ignore-not-found", "-o", "json"];
      if ("namespace" in resource.metadata) args.push("-n", resource.metadata.namespace);
      const prior = await kube(args);
      if (prior && JSON.parse(prior).metadata.labels?.["pocketcoder.dev/account"] !== account.id)
        throw new Error("Account resource identity mismatch");
    }
    for (const resource of resources)
      await kube(
        ["apply", "--server-side", "--field-manager=pocketcoder-manager", "-f", "-"],
        JSON.stringify(resource),
      );
    await kube(["-n", account.namespace, "rollout", "status", "deployment/controller", "--timeout=120s"]);
    await kube([
      "-n",
      account.namespace,
      "exec",
      "deployment/controller",
      "-c",
      "controller",
      "--",
      "bun",
      "-e",
      "if(!(await fetch('http://127.0.0.1:8090/readyz')).ok)process.exit(1)",
    ]);
  }
  async owner(account: Account, request: Awaited<ReturnType<ManagerStore["beginBootstrap"]>>) {
    const args = [
      "-n",
      account.namespace,
      "exec",
      "deployment/controller",
      "-c",
      "controller",
      "--",
      "bun",
      "/opt/pocketcoder/cli/index.js",
      "superuser",
      "create",
      "--dir",
      "/private/pc_data",
      "--automation",
      "--expires",
      request.expiresAt.toISOString(),
      "--request-id",
      request.requestId,
      "--json",
    ];
    if (request.replacesRequestId) args.push("--replace");
    // Plaintext exists only in this response. Repeated core request IDs return metadata and null.
    return OwnerResult.parse(JSON.parse(await kube(args)));
  }
}
