import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type createKubernetesCluster, ROOT } from "./kubernetes-cluster";

interface RbacResource {
  kind: string;
  metadata: { name: string; namespace?: string };
  subjects?: { namespace?: string }[];
  roleRef?: { kind: string; name: string };
}

type Cluster = Awaited<ReturnType<typeof createKubernetesCluster>>;

export async function controllerKubeconfig(cluster: Cluster, namespace: string) {
  const yaml = await Bun.file(join(ROOT, "deploy/kubernetes/pocketcoder.yaml")).text();
  const items = yaml
    .split(/^---$/m)
    .map((part) => Bun.YAML.parse(part) as RbacResource)
    .filter((item) =>
      ["ServiceAccount", "Role", "RoleBinding", "ClusterRole", "ClusterRoleBinding"].includes(item.kind),
    );
  for (const item of items) {
    if (item.kind.startsWith("Cluster")) item.metadata.name = `${cluster.name}-nodes`;
    else item.metadata.namespace = namespace;
    for (const subject of item.subjects ?? []) subject.namespace = namespace;
    if (item.roleRef?.kind === "ClusterRole") item.roleRef.name = `${cluster.name}-nodes`;
  }
  await cluster.kube(["apply", "-f", "-"], JSON.stringify({ apiVersion: "v1", kind: "List", items }));
  const token = await cluster.kube(["-n", namespace, "create", "token", "pocketcoder-controller", "--duration=30m"]);
  const original = JSON.parse(
    await cluster.run([
      "kubectl",
      "config",
      "view",
      "--kubeconfig",
      join(cluster.directory, "internal-kubeconfig"),
      "--raw",
      "-o",
      "json",
    ]),
  );
  const external = JSON.parse(
    await cluster.run(["kubectl", "config", "view", "--kubeconfig", cluster.kubeconfig, "--raw", "-o", "json"]),
  );
  async function writeConfig(name: string, clusters: typeof original.clusters) {
    const path = join(cluster.directory, name);
    await writeFile(
      path,
      JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        clusters,
        contexts: [{ name: "controller", context: { cluster: clusters[0].name, user: "controller", namespace } }],
        "current-context": "controller",
        users: [{ name: "controller", user: { token } }],
      }),
      { mode: 0o600 },
    );
    return path;
  }
  // The finite credential stays in the controller fixture, outside every workspace.
  return {
    internal: await writeConfig("controller-kubeconfig", original.clusters),
    external: await writeConfig("controller-external-kubeconfig", external.clusters),
  };
}
