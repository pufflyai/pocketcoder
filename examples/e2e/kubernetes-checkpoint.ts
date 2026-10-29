import { randomUUID } from "node:crypto";
import {
  OperationResourceSchema,
  PreserveResponseSchema,
  RestoreResponseSchema,
  WorkspaceResourceSchema,
} from "@pstdio/pocketcoder-contracts";
import { createHarnessWorkspace } from "./contract";
import { messageList, responseText } from "./contract-messages";
import { createKubernetesCluster } from "./kubernetes-cluster";
import { startKubernetesController } from "./kubernetes-controller";
import { assertQuotaDeniedCancellation } from "./kubernetes-empty-job";
import { assertRestoreRetry, assertRuntimeClassEnforced, cancelOnUnavailableNode } from "./kubernetes-provider-probes";
import { waitFor } from "./local-process";

const cluster = await createKubernetesCluster();
let controller: Awaited<ReturnType<typeof startKubernetesController>> | undefined;
const tree = {
  known: Buffer.from([0, 1, 10, 127, 128, 254, 255]).toString("base64"),
  "nested/deep/binary": Buffer.from("edited\u0000exact bytes\n").toString("base64"),
  "nested/empty": "",
};
try {
  const workspaceImage = await cluster.buildImage("workspace");
  const serverImage = await cluster.buildImage("server");
  const api = await startKubernetesController(cluster, serverImage.tag);
  controller = api;
  await assertQuotaDeniedCancellation(cluster, api);
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
        KUBECONFIG: api.externalKubeconfig,
        POCKETCODER_KUBERNETES_CONFORMANCE: "1",
        POCKETCODER_KUBERNETES_NAMESPACE: api.namespace,
      },
    ),
  );
  const manifest = await cluster.echoTemplate(workspaceImage.image);
  manifest.spec.resources.ephemeralStorage = "128Mi";
  manifest.spec.persistence = { mounts: [{ name: "work", target: "/work", maxBytes: 1024 ** 2, maxFiles: 100 }] };
  manifest.spec.setup = [
    {
      name: "verify-restored-tree",
      runOn: ["restore"],
      timeoutSeconds: 5,
      command: [
        "bun",
        "-e",
        `for(const [path,bytes] of Object.entries(${JSON.stringify(tree)})) if(Buffer.from(await Bun.file('/work/'+path).arrayBuffer()).toString('base64')!==bytes) throw new Error('Restore setup ran before exact tree publication');`,
      ],
    },
  ];
  const imported = await api.request("/v1/templates", { method: "POST", body: JSON.stringify({ manifest }) });
  if (!imported.ok) throw new Error(`Template import refused: ${await imported.text()}`);
  await cluster.kube(["cordon", cluster.nodes[1] as string]);
  const source = await createHarnessWorkspace({ baseUrl: api.baseUrl, key: api.key, template: "echo-harness" });
  const pods = JSON.parse(
    await cluster.kube([
      "-n",
      api.namespace,
      "get",
      "pods",
      "-l",
      `pocketcoder.workspace=${source.workspaceId}`,
      "-o",
      "json",
    ]),
  ).items;
  const sourcePod = pods[0];
  if (sourcePod.spec.nodeName !== cluster.nodes[0] || sourcePod.spec.runtimeClassName !== "pc-runc")
    throw new Error("Source node or RuntimeClass differs");
  if (sourcePod.spec.volumes.some((v: Record<string, unknown>) => v.persistentVolumeClaim || v.hostPath))
    throw new Error("Workspace has shared storage");
  await cluster.kube([
    "-n",
    api.namespace,
    "exec",
    sourcePod.metadata.name,
    "--",
    "bun",
    "-e",
    `await import('node:fs/promises').then(fs=>fs.mkdir('/work/nested/deep',{recursive:true}));for(const [path,bytes] of Object.entries(${JSON.stringify(tree)}))await Bun.write('/work/'+path,Buffer.from(bytes,'base64'));`,
  ]);
  const preserved = PreserveResponseSchema.parse(
    await (
      await api.request(`/v1/workspaces/${source.workspaceId}/preserve`, {
        method: "POST",
        headers: { "idempotency-key": randomUUID() },
        body: "{}",
      })
    ).json(),
  );
  async function operation(id: string) {
    await waitFor(
      async () => {
        const row = OperationResourceSchema.parse(await (await api.request(`/v1/operations/${id}`)).json());
        if (row.state === "failed") throw new Error(`Operation failed: ${row.reason_code}`);
        return row.state === "succeeded";
      },
      30_000,
      "durable operation",
    );
  }
  await operation(preserved.operation.id);
  const remaining = JSON.parse(
    await cluster.kube([
      "-n",
      api.namespace,
      "get",
      "pods",
      "-l",
      `pocketcoder.workspace=${source.workspaceId}`,
      "-o",
      "json",
    ]),
  ).items;
  if (remaining.length) throw new Error("Source pod survived preserve");
  await cluster.kube(["cordon", cluster.nodes[0] as string]);
  await cluster.kube(["uncordon", cluster.nodes[1] as string]);
  const restored = RestoreResponseSchema.parse(
    await (
      await api.request(`/v1/checkpoints/${preserved.checkpoint.id}/restore`, {
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
      if (row.state === "failed") throw new Error(`Restore failed: ${row.reason_code}`);
      return row.state === "ready";
    },
    30_000,
    "verified restored readiness",
  );
  await operation(restored.operation.id);
  const destination = JSON.parse(
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
  ).items[0];
  if (destination.spec.nodeName !== cluster.nodes[1] || destination.spec.runtimeClassName !== "pc-runc")
    throw new Error("Destination node or RuntimeClass differs");
  const actual = JSON.parse(
    await cluster.kube([
      "-n",
      api.namespace,
      "exec",
      destination.metadata.name,
      "--",
      "bun",
      "-e",
      `const tree={};for(const path of Object.keys(${JSON.stringify(tree)}))tree[path]=Buffer.from(await Bun.file('/work/'+path).arrayBuffer()).toString('base64');console.log(JSON.stringify(tree));`,
    ]),
  );
  if (JSON.stringify(actual) !== JSON.stringify(tree)) throw new Error("Cross-node restore changed file bytes");
  const prompt = `restored ${randomUUID()}`;
  const sent = await api.request(`/v1/workspaces/${restored.workspace.id}/agent/message`, {
    method: "POST",
    body: JSON.stringify({ type: "user", content: prompt }),
  });
  if (!sent.ok) throw new Error(`Agent message failed: ${await sent.text()}`);
  await waitFor(
    async () =>
      responseText(
        messageList(await (await api.request(`/v1/workspaces/${restored.workspace.id}/agent/messages`)).json()),
        0,
      ) === `echo: ${prompt}`,
    30_000,
    "restored echo agent",
  );
  await cancelOnUnavailableNode(cluster, api, restored.workspace.id);
  await assertRestoreRetry(cluster, api, preserved.checkpoint.id);
  await assertRuntimeClassEnforced(cluster, api);
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
    "owned destination cleanup",
  );
  console.log(
    JSON.stringify(
      {
        result: "passed",
        sourceNode: sourcePod.spec.nodeName,
        destinationNode: destination.spec.nodeName,
        sourceId: source.workspaceId,
        destinationId: restored.workspace.id,
        exactBytes: Object.values(tree).reduce((sum, value) => sum + Buffer.from(value, "base64").length, 0),
        runtimeClass: destination.spec.runtimeClassName,
        storage: "bounded emptyDir; private controller archives",
        cleanup:
          "source and canceled destination pods absent; unavailable node held capacity until recovery; fresh restore retry passed",
        launchCleanup: "atomic receipt and uncertain warm capacity checks passed under finite shipped RBAC",
        missingRuntimeClass: "rejected without fallback",
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (controller) {
    console.log(await cluster.run(["docker", "logs", controller.name]).catch(() => ""));
    const pods = JSON.parse(
      await cluster.kube(["-n", controller.namespace, "get", "pods", "-o", "json"]).catch(() => '{"items":[]}'),
    ).items;
    for (const pod of pods)
      console.log(await cluster.kube(["-n", controller.namespace, "logs", pod.metadata.name]).catch(() => ""));
    console.log(await cluster.kube(["-n", controller.namespace, "get", "pods", "-o", "wide"]).catch(() => ""));
    console.log(
      await cluster.kube(["-n", controller.namespace, "get", "events", "--sort-by=.lastTimestamp"]).catch(() => ""),
    );
  }
  throw error;
} finally {
  await controller?.close();
  await cluster.close();
}
