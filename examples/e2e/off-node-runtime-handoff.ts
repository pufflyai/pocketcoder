import { createKubernetesCluster } from "./kubernetes-cluster";
import { controllerKubeconfig } from "./kubernetes-controller-rbac";

const cluster = await createKubernetesCluster();
try {
  const namespace = "pc93-private-handoff";
  await cluster.kube(["create", "namespace", namespace]);
  const config = await controllerKubeconfig(cluster, namespace);
  console.log(
    await cluster.run(["bun", "test", "packages/server/src/recovery/off-node-runtime.conformance.test.ts"], undefined, {
      KUBECONFIG: config.external,
      POCKETCODER_KUBERNETES_CONFORMANCE: "1",
      POCKETCODER_KUBERNETES_NAMESPACE: namespace,
      RUN_S3_INTEGRATION: "1",
    }),
  );
} finally {
  await cluster.close();
}
