import { randomUUID } from "node:crypto";
import { RestoreResponseSchema, WorkspaceResourceSchema } from "@pstdio/pocketcoder-contracts";
import { createHarnessWorkspace } from "./contract";
import type { createKubernetesCluster } from "./kubernetes-cluster";
import type { startKubernetesController } from "./kubernetes-controller";
import { waitFor } from "./local-process";

type Cluster = Awaited<ReturnType<typeof createKubernetesCluster>>;
type Controller = Awaited<ReturnType<typeof startKubernetesController>>;

export async function cancelOnUnavailableNode(cluster: Cluster, api: Controller, workspaceId: string) {
  const worker = cluster.nodes[1];
  if (!worker) throw new Error("Worker node is missing");
  await cluster.run(["docker", "pause", worker]);
  try {
    await api.request(`/v1/workspaces/${workspaceId}/cancel`, { method: "POST" });
    await Bun.sleep(1000);
    const workspace = WorkspaceResourceSchema.parse(await (await api.request(`/v1/workspaces/${workspaceId}`)).json());
    const pods = JSON.parse(
      await cluster.kube([
        "-n",
        api.namespace,
        "get",
        "pods",
        "-l",
        `pocketcoder.workspace=${workspaceId}`,
        "-o",
        "json",
      ]),
    ).items;
    if (workspace.state !== "terminating" || workspace.terminal_at !== null || pods.length !== 1)
      throw new Error("Unproven node cleanup released active capacity");
    const retry = await api.request(`/v1/workspaces/${workspaceId}/cancel`, { method: "POST" });
    if (!retry.ok) throw new Error("Repeated cancellation failed");
  } finally {
    await cluster.run(["docker", "unpause", worker]);
  }
  await waitFor(
    async () => {
      const row = WorkspaceResourceSchema.parse(await (await api.request(`/v1/workspaces/${workspaceId}`)).json());
      const pods = JSON.parse(
        await cluster.kube([
          "-n",
          api.namespace,
          "get",
          "pods",
          "-l",
          `pocketcoder.workspace=${workspaceId}`,
          "-o",
          "json",
        ]),
      ).items;
      return row.state === "canceled" && pods.length === 0;
    },
    30_000,
    "node recovery and owned cleanup",
  );
}

export async function assertRuntimeClassEnforced(cluster: Cluster, api: Controller) {
  await cluster.kube(["delete", "runtimeclass", "pc-runc"]);
  try {
    const row = WorkspaceResourceSchema.parse(
      await (
        await api.request("/v1/workspaces", {
          method: "POST",
          headers: { "idempotency-key": randomUUID() },
          body: JSON.stringify({ external_id: randomUUID(), template: { name: "echo-harness" } }),
        })
      ).json(),
    );
    await waitFor(
      async () => {
        return (
          WorkspaceResourceSchema.parse(await (await api.request(`/v1/workspaces/${row.id}`)).json()).state === "failed"
        );
      },
      10_000,
      "missing RuntimeClass denial",
    );
    const pods = JSON.parse(
      await cluster.kube(["-n", api.namespace, "get", "pods", "-l", `pocketcoder.workspace=${row.id}`, "-o", "json"]),
    ).items;
    if (pods.length) throw new Error("Missing RuntimeClass fell back to the default runtime");
    const jobs = JSON.parse(
      await cluster.kube(["-n", api.namespace, "get", "jobs", "-l", `pocketcoder.workspace=${row.id}`, "-o", "json"]),
    ).items;
    if (jobs.length) throw new Error("Missing RuntimeClass left an admitted Job");
  } finally {
    await cluster.kube(
      ["apply", "-f", "-"],
      JSON.stringify({
        apiVersion: "node.k8s.io/v1",
        kind: "RuntimeClass",
        metadata: { name: "pc-runc" },
        handler: "runc",
      }),
    );
  }
  const retry = await createHarnessWorkspace({ baseUrl: api.baseUrl, key: api.key, template: "echo-harness" });
  await retry.cancel();
}

export async function assertRestoreRetry(cluster: Cluster, api: Controller, checkpointId: string) {
  const restored = RestoreResponseSchema.parse(
    await (
      await api.request(`/v1/checkpoints/${checkpointId}/restore`, {
        method: "POST",
        headers: { "idempotency-key": randomUUID() },
        body: JSON.stringify({ external_id: randomUUID() }),
      })
    ).json(),
  );
  await waitFor(
    async () => {
      const row = WorkspaceResourceSchema.parse(
        await (await api.request(`/v1/workspaces/${restored.workspace.id}`)).json(),
      );
      if (row.state === "failed") throw new Error(`Retry restore failed: ${row.reason_code}`);
      return row.state === "ready";
    },
    30_000,
    "fresh restore after cancellation",
  );
  await api.request(`/v1/workspaces/${restored.workspace.id}/cancel`, { method: "POST" });
  await waitFor(
    async () =>
      JSON.parse(
        await cluster.kube([
          "-n",
          api.namespace,
          "get",
          "pods",
          "-l",
          `pocketcoder.workspace=${restored.workspace.id}`,
          "-o",
          "json",
        ]),
      ).items.length === 0,
    30_000,
    "retry pod removal",
  );
}
