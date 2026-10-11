import { randomUUID } from "node:crypto";
import { RestoreResponseSchema, WarmPoolInventorySchema, WorkspaceResourceSchema } from "@pstdio/pocketcoder-contracts";
import { createHarnessWorkspace } from "./contract";
import { waitFor } from "./local-process";
import { managedLifecycleFixture } from "./managed-lifecycle-fixture";

const f = await managedLifecycleFixture();
type AccountResponse = { account: { id: string; namespace: string }; operation: { id: string } };
type Operation = { id: string; state: string; phase: string; errorCode: string | null };
let paused = false;
const worker = f.cluster.nodes[1];
try {
  if (!worker) throw new Error("Worker node is missing");
  await f.cluster.kube(["cordon", worker]);
  const created = (await (
    await f.request("/v1/accounts", {
      method: "POST",
      headers: { "idempotency-key": "lifecycle-account" },
      body: JSON.stringify({ name: "lifecycle" }),
    })
  ).json()) as AccountResponse;
  const { id, namespace } = created.account;
  console.log("Account admitted");
  const lifecycle = async (kind: "suspend" | "resume", identity: string) => {
    const response = await f.request(`/v1/accounts/${id}/${kind}`, {
      method: "POST",
      headers: { "idempotency-key": identity },
    });
    if (response.status !== 202) throw new Error(`Lifecycle admission failed: ${response.status}`);
    return (await response.json()) as AccountResponse;
  };
  const operation = async (id: string) => (await (await f.request(`/v1/operations/${id}`)).json()) as Operation;
  await f.reconcile();
  if ((await operation(created.operation.id)).state !== "succeeded") throw new Error("Account provisioning failed");
  const owner = (await (
    await f.request(`/v1/accounts/${id}/owner`, {
      method: "POST",
      body: JSON.stringify({
        request_id: randomUUID(),
        expires_at: new Date(Date.now() + 20 * 60_000).toISOString(),
      }),
    })
  ).json()) as { token: string };
  let url = await f.connect(namespace);
  const request = (path: string, init: RequestInit = {}) =>
    fetch(`${url}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json", ...init.headers },
    });
  const persistent = await f.cluster.echoTemplate(f.workspace.image);
  persistent.metadata.name = "suspend-persistent";
  persistent.spec.resources.ephemeralStorage = "128Mi";
  persistent.spec.persistence = { mounts: [{ name: "work", target: "/work", maxBytes: 1024 ** 2, maxFiles: 100 }] };
  persistent.spec.setup = [
    {
      name: "verify-data",
      runOn: ["restore"],
      command: [
        "bun",
        "-e",
        "if(await Bun.file('/work/saved.txt').text()!=='saved before suspension')throw Error('Saved bytes changed')",
      ],
      timeoutSeconds: 5,
    },
  ];
  const cold = await f.cluster.echoTemplate(f.workspace.image);
  cold.metadata.name = "suspend-cold";
  cold.spec.resources.ephemeralStorage = "128Mi";
  for (const manifest of [persistent, cold]) {
    if (!(await request("/v1/templates", { method: "POST", body: JSON.stringify({ manifest }) })).ok)
      throw new Error("Template import failed");
  }
  const saved = await createHarnessWorkspace({ baseUrl: url, key: owner.token, template: persistent.metadata.name });
  const pods = JSON.parse(
    await f.cluster.kube([
      "-n",
      namespace,
      "get",
      "pods",
      "-l",
      `pocketcoder.workspace=${saved.workspaceId}`,
      "-o",
      "json",
    ]),
  ).items;
  if (pods[0].spec.nodeName !== f.cluster.nodes[0]) throw new Error("Persistent workspace node differs");
  await f.cluster.kube([
    "-n",
    namespace,
    "exec",
    pods[0].metadata.name,
    "--",
    "bun",
    "-e",
    "await Bun.write('/work/saved.txt','saved before suspension')",
  ]);
  await f.cluster.kube([
    "-n",
    namespace,
    "patch",
    "deployment",
    "controller",
    "--type=merge",
    "-p",
    JSON.stringify({
      spec: { template: { spec: { nodeSelector: { "kubernetes.io/hostname": f.cluster.nodes[0] } } } },
    }),
  ]);
  await f.cluster.kube(["-n", namespace, "rollout", "status", "deployment/controller", "--timeout=120s"]);
  await f.cluster.kube(["uncordon", worker]);
  await f.cluster.kube([
    "-n",
    namespace,
    "set",
    "env",
    "deployment/controller",
    `POCKETCODER_WARM_POOLS=${JSON.stringify([{ template: cold.metadata.name, min_ready: 1 }])}`,
    `POCKETCODER_KUBERNETES_NODE_SELECTOR=${JSON.stringify({ "kubernetes.io/hostname": worker })}`,
  ]);
  await f.cluster.kube(["-n", namespace, "rollout", "status", "deployment/controller", "--timeout=120s"]);
  url = await f.connect(namespace);
  const volatile = await createHarnessWorkspace({ baseUrl: url, key: owner.token, template: cold.metadata.name });
  await waitFor(
    async () =>
      JSON.parse(
        await f.cluster.kube(["-n", namespace, "get", "pods", "-l", "pocketcoder.pool-runtime", "-o", "json"]),
      ).items.some(
        (pod: { spec: { nodeName: string }; status: { phase: string } }) =>
          pod.spec.nodeName === worker && pod.status.phase === "Running",
      ),
    30_000,
    "warm runtime on worker",
  );
  await waitFor(
    async () => {
      const pool = WarmPoolInventorySchema.parse(await (await request("/v1/warm-pools")).json()).items[0];
      return !!pool && (pool.counts.ready ?? 0) >= 1 && (pool.counts.provisioning ?? 0) === 0;
    },
    30_000,
    "settled ready warm runtime",
  );
  console.log("Active and warm runtimes ready; pausing worker");
  await f.cluster.run(["docker", "pause", worker]);
  paused = true;
  const suspended = await lifecycle("suspend", "suspend-first");
  await f.reconcile();
  const pending = await operation(suspended.operation.id);
  if (pending.state === "succeeded" || pending.errorCode !== "suspend_retry")
    throw new Error("Unreachable runtime completed suspension");
  const deployment = JSON.parse(
    await f.cluster.kube(["-n", namespace, "get", "deployment", "controller", "-o", "json"]),
  );
  if (deployment.spec.replicas !== 1) throw new Error("Unproven cleanup scaled controller down");
  if ((await request("/v1/workspaces", { method: "POST", body: "{}" })).status !== 503)
    throw new Error("Suspension admitted a launch");
  console.log("Suspension pending with controller running; restarting manager and controller");
  await f.restartManager();
  const retry = await lifecycle("suspend", "suspend-first");
  if (retry.operation.id !== suspended.operation.id) throw new Error("Manager restart duplicated operation");
  const controllers = () =>
    f.cluster.kube(["-n", namespace, "get", "pods", "-l", "pocketcoder.dev/role=controller", "-o", "json"]);
  const previous = new Set(
    JSON.parse(await controllers()).items.map((pod: { metadata: { uid: string } }) => pod.metadata.uid),
  );
  await f.cluster.kube(["-n", namespace, "rollout", "restart", "deployment/controller"]);
  let replacement: string | undefined;
  await waitFor(
    async () => {
      const pod = JSON.parse(await controllers()).items.find(
        (pod: {
          metadata: { uid: string; name: string; deletionTimestamp?: string };
          status: { containerStatuses?: { name: string; state: { running?: object } }[] };
        }) =>
          !previous.has(pod.metadata.uid) &&
          !pod.metadata.deletionTimestamp &&
          pod.status.containerStatuses?.some((container) => container.name === "controller" && container.state.running),
      );
      replacement = pod?.metadata.name;
      return !!replacement;
    },
    120_000,
    "replacement controller container",
  );
  if (!replacement) throw new Error("Replacement controller is missing");
  const marker = JSON.parse(
    await f.cluster.kube([
      "-n",
      namespace,
      "exec",
      replacement,
      "-c",
      "controller",
      "--",
      "bun",
      "-e",
      "console.log(JSON.stringify(await Bun.file('/private/pc_data/account-lifecycle.json').json()))",
    ]),
  );
  if (marker.state !== "suspending" || marker.current?.id !== suspended.operation.id)
    throw new Error("Replacement controller lost durable suspension");
  await f.cluster.run(["docker", "unpause", worker]);
  paused = false;
  await f.cluster.kube(["-n", namespace, "rollout", "status", "deployment/controller", "--timeout=120s"]);
  url = await f.connect(namespace);
  if ((await request("/v1/workspaces", { method: "POST", body: "{}" })).status !== 503)
    throw new Error("Controller restart lost suspension fence");
  await waitFor(
    async () => {
      await f.reconcile();
      return (await operation(suspended.operation.id)).state === "succeeded";
    },
    120_000,
    "suspension after node recovery",
  );
  const remaining = JSON.parse(await f.cluster.kube(["-n", namespace, "get", "pods", "-o", "json"])).items;
  if (remaining.length) throw new Error("Suspended account still has compute");
  console.log("Suspension proved zero pods; resuming");
  const resumed = await lifecycle("resume", "resume-first");
  await f.reconcile();
  if ((await operation(resumed.operation.id)).state !== "succeeded") throw new Error("Resume reconciliation failed");
  url = await f.connect(namespace);
  const source = WorkspaceResourceSchema.parse(await (await request(`/v1/workspaces/${saved.workspaceId}`)).json());
  const canceled = WorkspaceResourceSchema.parse(
    await (await request(`/v1/workspaces/${volatile.workspaceId}`)).json(),
  );
  if (source.state !== "preserved" || canceled.state !== "canceled")
    throw new Error("Suspend workspace outcomes differ");
  const checkpoints = (await (await request(`/v1/workspaces/${saved.workspaceId}/checkpoints`)).json()) as {
    items: { id: string; state: string }[];
  };
  if (checkpoints.items.length !== 1 || checkpoints.items[0]?.state !== "ready")
    throw new Error("Checkpoint effect was duplicated or lost");
  const checkpoint = checkpoints.items[0];
  if (!checkpoint) throw new Error("Saved checkpoint is missing");
  console.log("Resume retained one checkpoint; restoring saved data");
  const restored = RestoreResponseSchema.parse(
    await (
      await request(`/v1/checkpoints/${checkpoint.id}/restore`, {
        method: "POST",
        headers: { "idempotency-key": "restore-saved" },
        body: JSON.stringify({ external_id: randomUUID() }),
      })
    ).json(),
  );
  await waitFor(
    async () =>
      WorkspaceResourceSchema.parse(await (await request(`/v1/workspaces/${restored.workspace.id}`)).json()).state ===
      "ready",
    30_000,
    "saved bytes restored before setup",
  );
  await lifecycle("suspend", "suspend-first");
  await lifecycle("resume", "resume-first");
  await f.reconcile();
  if (
    WorkspaceResourceSchema.parse(await (await request(`/v1/workspaces/${restored.workspace.id}`)).json()).state !==
    "ready"
  )
    throw new Error("Completed suspend effect replayed");
  console.log(
    JSON.stringify(
      {
        result: "passed",
        account: id,
        suspension: "pending for unreachable warm/active runtime; zero pods before scale-down",
        restart: "same manager operation and durable controller fence",
        data: "one checkpoint, exact bytes restored before setup",
        retries: "completed operations do not replay",
        runtime: "local Kind pc-runc; hosted acceptance remains unproven",
      },
      null,
      2,
    ),
  );
} finally {
  if (paused && worker) await f.cluster.run(["docker", "unpause", worker]);
  await f.close();
}
