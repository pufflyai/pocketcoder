import { createKubernetesCluster } from "./kubernetes-cluster";
import { controllerKubeconfig } from "./kubernetes-controller-rbac";

const cluster = await createKubernetesCluster();
try {
  const namespace = "pc-launch";
  await cluster.kube(["create", "namespace", namespace]);
  const config = await controllerKubeconfig(cluster, namespace);
  console.log(
    await cluster.run(
      [
        "bun",
        "test",
        "packages/drivers/src/kubernetes/kubernetes-launch.conformance.test.ts",
        "packages/drivers/src/kubernetes/kubernetes-warm-cleanup.conformance.test.ts",
      ],
      undefined,
      {
        KUBECONFIG: config.external,
        POCKETCODER_KUBERNETES_CONFORMANCE: "1",
        POCKETCODER_KUBERNETES_NAMESPACE: namespace,
      },
    ),
  );
  console.log("Finite controller RBAC: launch claim and warm cleanup passed");
} finally {
  await cluster.close();
}
