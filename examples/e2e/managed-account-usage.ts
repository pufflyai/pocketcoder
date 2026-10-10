import { randomUUID } from "node:crypto";
import { usageSampler } from "@pstdio/pocketcoder-manager";
import type { ManagerStore } from "@pstdio/pocketcoder-manager/store";
import type { createKubernetesCluster } from "./kubernetes-cluster";
import { waitFor } from "./local-process";

export async function assertManagedUsage(
  cluster: Awaited<ReturnType<typeof createKubernetesCluster>>,
  store: ManagerStore,
  accountId: string,
  request: (path: string) => Promise<Response>,
) {
  const account = await store.getAccount(accountId);
  if (!account) throw new Error("Usage account missing");
  const namespace = account.namespace;
  const names = ["usage-warm", "usage-deleting", "usage-finished"];
  const sampler = usageSampler(store);
  try {
    for (const [index, name] of names.entries()) {
      const finished = index === 2;
      const metadata = {
        name,
        namespace,
        labels: { [index ? "pocketcoder.workspace" : "pocketcoder.pool-runtime"]: randomUUID() },
        ...(index === 1 ? { finalizers: ["pocketcoder.dev/usage-fixture"] } : {}),
      };
      const spec = {
        restartPolicy: "Never",
        automountServiceAccountToken: false,
        runtimeClassName: "pc-runc",
        terminationGracePeriodSeconds: 0,
        containers: [
          {
            name: "workspace",
            image: account.plan.controllerImage,
            command: ["bun", "-e", finished ? "process.exit(0)" : "await new Promise(()=>{})"],
            resources: {
              requests: { cpu: "10m", memory: "32Mi", "ephemeral-storage": "16Mi" },
              limits: { cpu: "10m", memory: "32Mi", "ephemeral-storage": "16Mi" },
            },
          },
        ],
      };
      const resource = finished
        ? {
            apiVersion: "batch/v1",
            kind: "Job",
            metadata,
            spec: { template: { metadata: { labels: metadata.labels }, spec } },
          }
        : { apiVersion: "v1", kind: "Pod", metadata, spec };
      await cluster.kube(["create", "-f", "-"], JSON.stringify(resource));
    }
    await cluster.kube([
      "-n",
      namespace,
      "wait",
      "--for=condition=Ready",
      "pod/usage-warm",
      "pod/usage-deleting",
      "--timeout=30s",
    ]);
    await cluster.kube(["-n", namespace, "wait", "--for=condition=Complete", "job/usage-finished", "--timeout=30s"]);
    await cluster.kube(["-n", namespace, "delete", "pod/usage-deleting", "--wait=false"]);
    const at = new Date();
    await sampler.sample(at);
    await sampler.sample(at);
    await waitFor(
      async () => {
        const response = await request(`/v1/accounts/${accountId}/usage`);
        if (!response.ok) throw new Error(`Usage endpoint failed: ${await response.text()}`);
        const usage = (await response.json()) as {
          observed_peak: number;
          observed_warm_peak: number;
          estimated_workspace_seconds: number;
          volume_bytes: number;
          coverage: { recorded_samples: number; workspace_samples: number; volume_samples: number };
        };
        if (
          usage.observed_peak !== 1 ||
          usage.observed_warm_peak !== 1 ||
          !(usage.volume_bytes > 0) ||
          usage.coverage.recorded_samples !== 1 ||
          usage.coverage.workspace_samples !== 1 ||
          usage.coverage.volume_samples !== 1
        )
          throw new Error(`Managed usage differs: ${JSON.stringify(usage)}`);
        return usage.estimated_workspace_seconds > 0;
      },
      5000,
      "managed usage estimate",
    );
    const other = (await store.listAccounts()).find((row) => row.id !== accountId);
    if (!other || (await store.getUsage(other.id)).observed_peak !== 0) throw new Error("Usage crossed accounts");
  } finally {
    await sampler.close();
    await cluster
      .kube(["-n", namespace, "patch", "pod/usage-deleting", "--type=merge", "-p", '{"metadata":{"finalizers":[]}}'])
      .catch(() => {});
    await cluster.kube(["-n", namespace, "delete", "pod/usage-warm", "job/usage-finished", "--ignore-not-found"]);
  }
}
