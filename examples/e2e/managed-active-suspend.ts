import { randomUUID } from "node:crypto";
import { WarmPoolInventorySchema } from "@pstdio/pocketcoder-contracts";
import { KubernetesAccounts } from "@pstdio/pocketcoder-manager/kubernetes";
import { createHarnessWorkspace } from "./contract";
import { waitFor } from "./local-process";
import { lifecycleDiagnostic, managedDiagnostics, managedStorageDiagnostics } from "./managed-diagnostics";
import { managedLifecycleFixture } from "./managed-lifecycle-fixture";
import { offNodeFixture } from "./off-node-fixture";

// This isolates suspension from capture so a backup failure cannot hide an active-runtime drain failure.
const storage = await offNodeFixture();
let fixture: Awaited<ReturnType<typeof managedLifecycleFixture>> | undefined;
let namespace: string | undefined;
let failureOperation: string | undefined;
try {
  fixture = await managedLifecycleFixture(storage.configure);
  const f = fixture;
  const created = await post("/v1/accounts", "account", { name: "active-suspend" });
  const id = created.account.id;
  namespace = created.account.namespace;
  await f.reconcile();
  if ((await operation(created.operation.id)).state !== "succeeded") throw new Error("Provisioning pending.");
  await managedStorageDiagnostics(f, namespace);
  const owner = await f.request(`/v1/accounts/${id}/owner`, {
    method: "POST",
    body: JSON.stringify({ request_id: randomUUID(), expires_at: new Date(Date.now() + 20 * 60_000).toISOString() }),
  });
  const token = ((await owner.json()) as { token: string }).token;
  if (!owner.ok || !token) throw new Error("Finite owner admission failed.");
  let url = await f.connect(namespace);
  const request = (path: string, input: RequestInit = {}) =>
    fetch(`${url}${path}`, {
      ...input,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...input.headers },
    });
  const manifest = await f.cluster.echoTemplate(f.workspace.image);
  manifest.metadata.name = "active-suspend";
  manifest.spec.resources.ephemeralStorage = "128Mi";
  const imported = await request("/v1/templates", { method: "POST", body: JSON.stringify({ manifest }) });
  if (!imported.ok) throw new Error(`Template admission failed: ${imported.status}`);
  await f.cluster.kube([
    "-n",
    namespace,
    "set",
    "env",
    "deployment/controller",
    `POCKETCODER_WARM_POOLS=${JSON.stringify([{ template: manifest.metadata.name, min_ready: 1 }])}`,
  ]);
  await f.cluster.kube(["-n", namespace, "rollout", "status", "deployment/controller", "--timeout=120s"]);
  url = await f.connect(namespace);
  await waitFor(
    async () =>
      (WarmPoolInventorySchema.parse(await (await request("/v1/warm-pools")).json()).items[0]?.counts.ready ?? 0) >= 1,
    30_000,
    "first warm runtime",
  );
  const workspace = await createHarnessWorkspace({ baseUrl: url, key: token, template: manifest.metadata.name });
  await waitFor(
    async () =>
      (WarmPoolInventorySchema.parse(await (await request("/v1/warm-pools")).json()).items[0]?.counts.ready ?? 0) >= 1,
    30_000,
    "replacement warm runtime",
  );
  const pods = JSON.parse(await f.cluster.kube(["-n", namespace, "get", "pods", "-o", "json"])).items;
  if (pods.length < 3) throw new Error("Controller, active and warm compute were not observed.");
  console.log(
    JSON.stringify({
      observed: "controller, active and replacement warm Pods",
      workspace: workspace.workspaceId,
      pods: pods.map((pod: { metadata: { uid: string } }) => pod.metadata.uid),
    }),
  );
  const admitted = await post(`/v1/accounts/${id}/suspend`, "suspend");
  try {
    await waitFor(
      async () => {
        await f.reconcile();
        return (await operation(admitted.operation.id)).state === "succeeded";
      },
      120_000,
      "same operation active and warm suspension",
    );
  } catch (error) {
    console.log(JSON.stringify({ operation: await operation(admitted.operation.id) }));
    await lifecycleDiagnostic(f, namespace, admitted.operation.id);
    const store = f.currentStore();
    const account = await store?.getAccount(id);
    const pending = await store?.getOperation(admitted.operation.id);
    // Call the same real Kubernetes helper to retain the provider error swallowed by reconciliation.
    if (store && account && pending) await new KubernetesAccounts().stopController.prepare(account, pending, store);
    throw error;
  }
  console.log(JSON.stringify({ operation: await operation(admitted.operation.id) }));
  if (JSON.parse(await f.cluster.kube(["-n", namespace, "get", "pods", "-o", "json"])).items.length)
    throw new Error("Account compute remains after suspension.");
  const proof = (await f.currentStore()?.getOperation(admitted.operation.id))?.computeProof;
  if (!proof?.controllerTermination || !proof.runtime) throw new Error("Actual termination proof is missing.");
  console.log(JSON.stringify({ result: "passed", proof, hosted: "DigitalOcean acceptance remains unproven" }));

  async function post(path: string, identity: string, body?: unknown) {
    const response = await f.request(path, {
      method: "POST",
      headers: { "idempotency-key": identity },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status !== 202) throw new Error(`Manager admission failed: ${response.status}`);
    const result = (await response.json()) as { account: { id: string; namespace: string }; operation: { id: string } };
    failureOperation = result.operation.id;
    return result;
  }
  async function operation(id: string) {
    return (await (await f.request(`/v1/operations/${id}`)).json()) as {
      state: string;
      phase: string;
      errorCode: string | null;
    };
  }
} catch (error) {
  console.error(error);
  if (fixture && namespace) await managedDiagnostics(fixture, namespace, failureOperation);
  throw error;
} finally {
  await fixture?.close();
  await storage.close();
}
