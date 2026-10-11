import { z } from "zod";
import type { Account, ManagerStore } from "../database/store";
import { kube } from "./command";
import { accountManifests } from "./manifests";

const OwnerResult = z
  .object({ token: z.string().nullable(), key: z.object({ id: z.uuid() }).passthrough() })
  .passthrough();
export class KubernetesAccounts {
  constructor(private readonly command = kube) {}
  async ensure(account: Account) {
    await this.command(["get", "runtimeclass", account.plan.runtimeClassName, "-o", "name"]);
    const hosts = account.plan.publicHosts;
    if (hosts) {
      await this.command(["get", "ingressclass", hosts.ingressClassName, "-o", "name"]);
      await this.command(["get", "clusterissuer", hosts.issuer, "-o", "name"]);
    }
    const cni = JSON.parse(await this.command(["-n", "kube-system", "get", "daemonset", "calico-node", "-o", "json"]));
    if (!cni.status.desiredNumberScheduled || cni.status.numberReady !== cni.status.desiredNumberScheduled)
      throw new Error("Calico enforcement is not ready");
    const endpoints = JSON.parse(
      await this.command([
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
      const prior = await this.command(args);
      if (prior && JSON.parse(prior).metadata.labels?.["pocketcoder.dev/account"] !== account.id)
        throw new Error("Account resource identity mismatch");
    }
    for (const resource of resources)
      await this.command(
        ["apply", "--server-side", "--field-manager=pocketcoder-manager", "-f", "-"],
        JSON.stringify(resource),
      );
    await this.command(["-n", account.namespace, "rollout", "status", "deployment/controller", "--timeout=120s"]);
    await this.command([
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
    if (hosts) await this.certificateReady(account);
  }
  private async certificateReady(account: Account) {
    // DNS validation can take minutes. Check once so other accounts keep moving; the next pass retries.
    const certificate = JSON.parse(
      await this.command(["-n", account.namespace, "get", "certificate", "public-hosts", "-o", "json"]),
    );
    const ready = certificate.status?.conditions?.some(
      (condition: { type: string; status: string; observedGeneration?: number }) =>
        condition.type === "Ready" &&
        condition.status === "True" &&
        condition.observedGeneration === certificate.metadata.generation,
    );
    if (!ready) throw new Error("Account certificate is not ready");
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
    return OwnerResult.parse(JSON.parse(await this.command(args)));
  }
}
