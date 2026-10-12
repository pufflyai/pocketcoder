import type { managedLifecycleFixture } from "./managed-lifecycle-fixture";

export async function monitoringContainerSignal(
  f: Awaited<ReturnType<typeof managedLifecycleFixture>>,
  namespace: string,
  selector: string,
) {
  const pods = JSON.parse(await f.cluster.kube(["-n", namespace, "get", "pods", "-l", selector, "-o", "json"]));
  const pod = pods.items[0];
  const container = pod?.status.containerStatuses
    ?.find((entry: { name: string }) => entry.name === "workspace")
    ?.containerID?.replace("containerd://", "");
  if (!container || !f.cluster.nodes.includes(pod.spec.nodeName))
    throw new Error("Monitoring fault has no owned running container");
  // A namespace's PID 1 ignores stop signals sent from that same namespace.
  return (name: string) =>
    f.cluster.run([
      "docker",
      "exec",
      pod.spec.nodeName,
      "ctr",
      "--namespace",
      "k8s.io",
      "tasks",
      "kill",
      "--signal",
      name,
      container,
    ]);
}
