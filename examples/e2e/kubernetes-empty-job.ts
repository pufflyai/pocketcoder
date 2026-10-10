import type { createKubernetesCluster } from "./kubernetes-cluster";
import type { startKubernetesController } from "./kubernetes-controller";

export async function assertQuotaDeniedCancellation(
  cluster: Awaited<ReturnType<typeof createKubernetesCluster>>,
  controller: Awaited<ReturnType<typeof startKubernetesController>>,
) {
  const namespace = controller.namespace;
  // The controller runs outside Kubernetes; no workspace Pods exist at this point.
  await cluster.kube(["-n", namespace, "create", "quota", "deny-workspace-pods", "--hard=pods=0"]);
  try {
    console.log(
      await cluster.run(
        ["bun", "test", "packages/drivers/src/kubernetes/kubernetes-empty-job.conformance.test.ts"],
        undefined,
        {
          KUBECONFIG: controller.externalKubeconfig,
          POCKETCODER_KUBERNETES_CONFORMANCE: "1",
          POCKETCODER_KUBERNETES_NAMESPACE: namespace,
        },
      ),
    );
  } finally {
    await cluster.kube(["-n", namespace, "delete", "quota", "deny-workspace-pods", "--wait=true"]);
  }
}
