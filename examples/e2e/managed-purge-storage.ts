import { createKindPurgeStorage } from "./kind-purge-storage";
import type { createKubernetesCluster } from "./kubernetes-cluster";

export async function managedPurgeStorage(cluster: Awaited<ReturnType<typeof createKubernetesCluster>>) {
  const settings = JSON.parse(
    await cluster.kube(["-n", "local-path-storage", "get", "configmap", "local-path-config", "-o", "json"]),
  );
  const root = "/var/local-path-provisioner";
  const provisioner = JSON.parse(settings.data["config.json"]);
  if (!provisioner.nodePathMap.every((node: { paths: string[] }) => node.paths.length === 1 && node.paths[0] === root))
    throw new Error("Owned Kind provisioner root differs.");
  const nodes = [];
  for (const name of cluster.nodes) {
    const node = JSON.parse(await cluster.kube(["get", "node", name, "-o", "json"]));
    const containerId = await cluster.run(["docker", "inspect", "--format", "{{.Id}}", name]);
    nodes.push({ name, uid: node.metadata.uid, providerId: node.spec.providerID, containerId });
  }
  return createKindPurgeStorage({ kube: cluster.kube, run: cluster.run, nodes, root });
}
