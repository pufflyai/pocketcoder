import { randomUUID } from "node:crypto";
import type { createKubernetesCluster } from "./kubernetes-cluster";
import { controllerKubeconfig } from "./kubernetes-controller-rbac";
import { command, freePort, waitFor } from "./local-process";

export async function startKubernetesController(
  cluster: Awaited<ReturnType<typeof createKubernetesCluster>>,
  image: string,
) {
  const name = `${cluster.name}-controller`;
  const namespace = "pc-restore";
  const port = freePort();
  await cluster.kube(["create", "namespace", namespace]);
  const kubeconfig = await controllerKubeconfig(cluster, namespace);
  await command(["docker", "volume", "create", name], { quiet: true });
  await command(
    [
      "docker",
      "run",
      "-d",
      "--name",
      name,
      "--network",
      "kind",
      "-p",
      `127.0.0.1:${port}:8090`,
      "--mount",
      `type=volume,src=${name},dst=/private`,
      "--mount",
      `type=bind,src=${kubeconfig.internal},dst=/config/kubeconfig,readonly`,
      "-e",
      "KUBECONFIG=/config/kubeconfig",
      "-e",
      "POCKETCODER_HTTP=0.0.0.0:8090",
      "-e",
      "POCKETCODER_AGENT_HTTP=0.0.0.0:8091",
      "-e",
      "POCKETCODER_DIR=/private/pc_data",
      "-e",
      "POCKETCODER_DRIVER=kubernetes",
      "-e",
      `POCKETCODER_KUBERNETES_NAMESPACE=${namespace}`,
      "-e",
      "POCKETCODER_KUBERNETES_RUNTIME_CLASS=pc-runc",
      "-e",
      "POCKETCODER_KUBERNETES_SERVICE_ACCOUNT=pocketcoder-workspace",
      "-e",
      "POCKETCODER_STORAGE_BACKEND=controller-archive",
      "-e",
      "POCKETCODER_CHECKPOINT_DIR=/private/checkpoints",
      "-e",
      `POCKETCODER_WORKSPACE_SERVER_URL=http://pocketcoder-agent.${namespace}.svc:8091`,
      image,
    ],
    { quiet: true },
  );
  try {
    const inspect = JSON.parse((await command(["docker", "inspect", name], { quiet: true })).stdout)[0];
    const address = inspect.NetworkSettings.Networks.kind.IPAddress;
    await cluster.kube(
      ["-n", namespace, "apply", "-f", "-"],
      JSON.stringify({
        apiVersion: "v1",
        kind: "List",
        items: [
          {
            apiVersion: "v1",
            kind: "Service",
            metadata: { name: "pocketcoder-agent" },
            spec: { ports: [{ name: "agent", port: 8091, targetPort: 8091 }] },
          },
          {
            apiVersion: "discovery.k8s.io/v1",
            kind: "EndpointSlice",
            metadata: { name: "pocketcoder-agent", labels: { "kubernetes.io/service-name": "pocketcoder-agent" } },
            addressType: "IPv4",
            ports: [{ name: "agent", port: 8091, protocol: "TCP" }],
            endpoints: [{ addresses: [address] }],
          },
        ],
      }),
    );
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitFor(
      () =>
        fetch(`${baseUrl}/readyz`)
          .then((r) => r.ok)
          .catch(() => false),
      30_000,
      "Kubernetes controller readiness",
    );
    const owner = JSON.parse(
      (
        await command(
          [
            "docker",
            "exec",
            name,
            "pocketcoder",
            "superuser",
            "create",
            "--dir",
            "/private/pc_data",
            "--automation",
            "--expires",
            new Date(Date.now() + 600_000).toISOString(),
            "--request-id",
            randomUUID(),
            "--json",
          ],
          { quiet: true },
        )
      ).stdout,
    );
    const request = (path: string, options: RequestInit = {}) =>
      fetch(`${baseUrl}${path}`, {
        ...options,
        headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}`, ...options.headers },
      });
    return {
      namespace,
      externalKubeconfig: kubeconfig.external,
      name,
      baseUrl,
      key: owner.token,
      request,
      async close() {
        await command(["docker", "rm", "--force", name], { quiet: true });
        await command(["docker", "volume", "rm", name], { quiet: true });
      },
    };
  } catch (error) {
    console.log((await command(["docker", "logs", name], { quiet: true })).stderr);
    await command(["docker", "rm", "--force", name], { quiet: true });
    await command(["docker", "volume", "rm", name], { quiet: true });
    throw error;
  }
}
