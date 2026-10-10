import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { createKubernetesCluster } from "./kubernetes-cluster";

export async function managerKubeconfig(
  cluster: Awaited<ReturnType<typeof createKubernetesCluster>>,
  internal = false,
) {
  await cluster.kube(["-n", "default", "create", "serviceaccount", "account-manager"]);
  await cluster.kube([
    "create",
    "clusterrolebinding",
    `${cluster.name}-manager`,
    "--clusterrole=cluster-admin",
    "--serviceaccount=default:account-manager",
  ]);
  const token = await cluster.kube(["-n", "default", "create", "token", "account-manager", "--duration=30m"]);
  const original = JSON.parse(
    await cluster.run([
      "kubectl",
      "config",
      "view",
      "--kubeconfig",
      internal ? join(cluster.directory, "internal-kubeconfig") : cluster.kubeconfig,
      "--raw",
      "-o",
      "json",
    ]),
  );
  const path = join(cluster.directory, "manager-kubeconfig");
  // This finite fixture authority stays on the host, outside account controllers and workspaces.
  await writeFile(
    path,
    JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      clusters: original.clusters,
      contexts: [{ name: "manager", context: { cluster: original.clusters[0].name, user: "manager" } }],
      "current-context": "manager",
      users: [{ name: "manager", user: { token } }],
    }),
    { mode: 0o600 },
  );
  return path;
}
