import { randomUUID } from "node:crypto";
import {
  ErrorEnvelopeSchema,
  RestoreResponseSchema,
  WarmPoolInventorySchema,
  WorkspaceResourceSchema,
} from "@pstdio/pocketcoder-contracts";
import { KubernetesAccounts } from "@pstdio/pocketcoder-manager/kubernetes";
import { createHarnessWorkspace } from "./contract";
import { waitFor } from "./local-process";
import {
  lifecycleDiagnostic,
  managedDiagnostics,
  managedStorageDiagnostics,
  recoveryDiagnostic,
} from "./managed-diagnostics";
import { managedLifecycleFixture } from "./managed-lifecycle-fixture";
import { observeManagedWarm, prepareManagedWarm, requireManagedWarmProof } from "./managed-warm";
import { offNodeFixture } from "./off-node-fixture";

const storage = await offNodeFixture();
let f: Awaited<ReturnType<typeof managedLifecycleFixture>> | undefined;
let failureNamespace: string | undefined;
let failureOperation: string | undefined;
type AccountResponse = { account: { id: string; namespace: string }; operation: { id: string } };
type Operation = { id: string; state: string; phase: string; errorCode: string | null };
try {
  f = await managedLifecycleFixture(storage.configure);
  const fixture = f;
  const created = await managerPost("/v1/accounts", "account", { name: "off-node" });
  const { id, namespace } = created.account;
  failureNamespace = namespace;
  await fixture.reconcile();
  if ((await operation(created.operation.id)).state !== "succeeded") throw new Error("Account provisioning pending.");
  await managedStorageDiagnostics(fixture, namespace);
  console.log("Managed encrypted journal account ready.");
  const firstOwner = randomUUID();
  const owner = await ownerKey(firstOwner);
  let token = owner.token;
  let url = await fixture.connect(namespace);
  const request = (path: string, input: RequestInit = {}) =>
    fetch(`${url}${path}`, {
      ...input,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...input.headers },
    });
  const persistent = await fixture.cluster.echoTemplate(fixture.workspace.image);
  persistent.metadata.name = "off-node-saved";
  persistent.spec.resources.ephemeralStorage = "128Mi";
  persistent.spec.persistence = { mounts: [{ name: "work", target: "/work", maxBytes: 1024 ** 2, maxFiles: 100 }] };
  persistent.spec.setup = [
    {
      name: "saved-bytes",
      runOn: ["restore"],
      command: [
        "bun",
        "-e",
        "if(await Bun.file('/work/saved.txt').text()!=='off-node saved bytes')throw Error('Saved bytes changed')",
      ],
      timeoutSeconds: 5,
    },
  ];
  const cold = await fixture.cluster.echoTemplate(fixture.workspace.image);
  cold.metadata.name = "off-node-active";
  cold.spec.resources.ephemeralStorage = "128Mi";
  for (const manifest of [persistent, cold]) {
    if (!(await request("/v1/templates", { method: "POST", body: JSON.stringify({ manifest }) })).ok)
      throw new Error("Template import failed.");
  }
  const kept = await checkpoint("keep");
  const deleted = await checkpoint("delete");
  const historical = await createHarnessWorkspace({ baseUrl: url, key: token, template: cold.metadata.name });
  const capturedJobs = JSON.parse(
    await fixture.cluster.kube([
      "-n",
      namespace,
      "get",
      "jobs",
      "-l",
      `pocketcoder.workspace=${historical.workspaceId}`,
      "-o",
      "json",
    ]),
  ).items;
  if (capturedJobs.length !== 1 || !capturedJobs[0].metadata.uid)
    throw new Error("Running runtime identity before capture is missing.");
  console.log(
    JSON.stringify({
      captureRuntime: {
        workspace: historical.workspaceId,
        job: capturedJobs[0].metadata.name,
        uid: capturedJobs[0].metadata.uid,
      },
    }),
  );
  url = await prepareManagedWarm(fixture, namespace, cold.metadata.name, token);
  const capturedWarm = await observeManagedWarm(fixture, namespace);
  const captured = await managerPost(`/v1/accounts/${id}/backups`, "capture");
  await fixture.reconcile();
  if ((await operation(captured.operation.id)).state !== "succeeded") {
    console.log(
      await fixture.cluster.kube([
        "-n",
        namespace,
        "exec",
        "deployment/controller",
        "-c",
        "controller",
        "--",
        "bun",
        "-e",
        "const h=await import('node:http');const id=process.argv[1];await new Promise((resolve,reject)=>{const r=h.request({socketPath:'/private/pc_data/admin.sock',path:'/v1/backup/off-node',method:'POST',headers:{'content-type':'application/json'}},s=>{let b='';s.on('data',v=>b+=v);s.on('end',()=>{console.log(JSON.stringify({status:s.statusCode,response:JSON.parse(b)}));resolve()})});r.on('error',reject);r.end(JSON.stringify({operation_id:id}))})",
        captured.operation.id,
      ]),
    );
    throw new Error("Encrypted backup remains pending.");
  }
  const versions = await storage.storage.storage.versions(`accounts/${id}/backups/`);
  if (!versions.length) throw new Error("Backup version missing.");
  const canceled = await request(`/v1/workspaces/${historical.workspaceId}/cancel`, { method: "POST" });
  if (!canceled.ok) throw new Error("Post-capture runtime cancellation failed.");
  await waitFor(
    async () => {
      const row = WorkspaceResourceSchema.parse(
        await (await request(`/v1/workspaces/${historical.workspaceId}`)).json(),
      );
      const jobs = JSON.parse(
        await fixture.cluster.kube([
          "-n",
          namespace,
          "get",
          "jobs",
          "-l",
          `pocketcoder.workspace=${historical.workspaceId}`,
          "-o",
          "json",
        ]),
      ).items;
      return row.state === "canceled" && jobs.length === 0;
    },
    30_000,
    "captured runtime finished and provider removed before suspension",
  );
  console.log(
    JSON.stringify({ finishedBeforeSuspend: historical.workspaceId, removedJobUid: capturedJobs[0].metadata.uid }),
  );
  const deletion = await request(`/v1/checkpoints/${deleted}`, {
    method: "DELETE",
    headers: { "idempotency-key": "delete-after-backup" },
  });
  if (deletion.status !== 202) throw new Error("Post-backup checkpoint deletion failed.");
  const secondOwner = randomUUID();
  token = (await ownerKey(secondOwner, firstOwner)).token;
  if ((await fetch(`${url}/v1/keys`, { headers: { authorization: `Bearer ${owner.token}` } })).status !== 401)
    throw new Error("Old key still authenticates.");
  await createHarnessWorkspace({ baseUrl: url, key: token, template: cold.metadata.name });
  await waitFor(
    async () =>
      (WarmPoolInventorySchema.parse(await (await request("/v1/warm-pools")).json()).items[0]?.counts.ready ?? 0) >= 1,
    30_000,
    "warm runtime ready",
  );
  console.log("Backup captured; later content deletion/revocation and active/warm compute admitted.");
  const suspended = await managerPost(`/v1/accounts/${id}/suspend`, "suspend");
  try {
    await waitFor(
      async () => {
        await fixture.reconcile();
        return (await operation(suspended.operation.id)).state === "succeeded";
      },
      120_000,
      "same operation source suspension",
    );
  } catch (error) {
    await lifecycleDiagnostic(fixture, namespace, suspended.operation.id);
    const store = fixture.currentStore();
    const account = await store?.getAccount(id);
    const pending = await store?.getOperation(suspended.operation.id);
    if (store && account && pending) await new KubernetesAccounts().stopController.prepare(account, pending, store);
    throw error;
  }
  await fixture.restartManager();
  await requireManagedWarmProof(fixture, suspended.operation.id, captured.operation.id, capturedWarm);
  await managerPost(`/v1/accounts/${id}/suspend`, "suspend");
  await fixture.reconcile();
  if (JSON.parse(await fixture.cluster.kube(["-n", namespace, "get", "pods", "-o", "json"])).items.length)
    throw new Error("Source compute remains.");
  console.log("Original controller and active/warm container exits retained; source compute is zero.");
  const restored = await managerPost(`/v1/accounts/${id}/restore`, "restore", { backup_id: captured.operation.id });
  await waitFor(
    async () => {
      await fixture.reconcile();
      return (await operation(restored.operation.id)).state === "succeeded";
    },
    180_000,
    "managed private fresh-volume restore",
  );
  await fixture.restartManager();
  const repeated = await managerPost(`/v1/accounts/${id}/restore`, "restore", { backup_id: captured.operation.id });
  if (repeated.operation.id !== restored.operation.id) throw new Error("Restore replay changed operation.");
  await fixture.reconcile();
  if (JSON.stringify(await storage.storage.storage.versions(`accounts/${id}/backups/`)) !== JSON.stringify(versions))
    throw new Error("Backup effect replayed.");
  url = await fixture.connect(namespace);
  if ((await fetch(`${url}/v1/keys`, { headers: { authorization: `Bearer ${owner.token}` } })).status !== 401)
    throw new Error("Backup resurrected revoked authority.");
  token = (await ownerKey(randomUUID(), secondOwner)).token;
  const removed = await request(`/v1/checkpoints/${deleted}`);
  const removedBody = await removed.json();
  console.log(JSON.stringify({ deletedCheckpoint: { id: deleted, status: removed.status, response: removedBody } }));
  const archiveFiles = JSON.parse(
    await fixture.cluster.kube([
      "-n",
      namespace,
      "exec",
      "deployment/controller",
      "-c",
      "controller",
      "--",
      "bun",
      "-e",
      "console.log(JSON.stringify(await (await import('node:fs/promises')).readdir('/private/checkpoints')))",
    ]),
  );
  console.log(JSON.stringify({ restoredCheckpointArchives: archiveFiles, deleted, kept }));
  if (removed.status !== 404 || ErrorEnvelopeSchema.parse(removedBody).error.code !== "checkpoint.not_found")
    throw new Error("Deleted checkpoint remains accessible after restore.");
  if (archiveFiles.some((name: string) => name.includes(deleted))) throw new Error("Deleted archive bytes remain.");
  const workspace = RestoreResponseSchema.parse(
    await (
      await request(`/v1/checkpoints/${kept}/restore`, {
        method: "POST",
        headers: { "idempotency-key": "restore-kept" },
        body: JSON.stringify({ external_id: randomUUID() }),
      })
    ).json(),
  );
  await waitFor(
    async () =>
      WorkspaceResourceSchema.parse(await (await request(`/v1/workspaces/${workspace.workspace.id}`)).json()).state ===
      "ready",
    30_000,
    "exact saved bytes restored",
  );
  const volumes = JSON.parse(await fixture.cluster.kube(["-n", namespace, "get", "pvc", "-o", "json"])).items;
  if (volumes.length !== 2) throw new Error("Original/new volume inventory differs.");
  console.log(
    JSON.stringify(
      {
        result: "passed",
        account: id,
        recovery: "fresh volume, current off-node journal, later deletion/revocation enforced before admission",
        data: "kept checkpoint restores exact saved bytes",
        inventory: "original and new PVC identities retained",
        replay: "one backup version and restore identity",
        runtime: "local Kind and RustFS; hosted Spaces/block-volume acceptance unproven",
      },
      null,
      2,
    ),
  );

  async function managerPost(path: string, identity: string, body?: unknown) {
    const response = await fixture.request(path, {
      method: "POST",
      headers: { "idempotency-key": identity },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status !== 202) throw new Error(`Manager admission failed ${path}: ${response.status}`);
    const result = (await response.json()) as AccountResponse;
    failureOperation = result.operation.id;
    return result;
  }
  async function operation(operationId: string) {
    return (await (await fixture.request(`/v1/operations/${operationId}`)).json()) as Operation;
  }
  async function ownerKey(requestId: string, replacesRequestId?: string) {
    const response = await fixture.request(`/v1/accounts/${id}/owner`, {
      method: "POST",
      body: JSON.stringify({
        request_id: requestId,
        expires_at: new Date(Date.now() + 20 * 60_000).toISOString(),
        ...(replacesRequestId ? { replaces_request_id: replacesRequestId } : {}),
      }),
    });
    const result = (await response.json()) as { token: string };
    if (!response.ok || !result.token) throw new Error("Finite private owner grant failed.");
    return result;
  }
  async function checkpoint(identity: string) {
    const workspace = await createHarnessWorkspace({ baseUrl: url, key: token, template: persistent.metadata.name });
    const pods = JSON.parse(
      await fixture.cluster.kube([
        "-n",
        namespace,
        "get",
        "pods",
        "-l",
        `pocketcoder.workspace=${workspace.workspaceId}`,
        "-o",
        "json",
      ]),
    ).items;
    await fixture.cluster.kube([
      "-n",
      namespace,
      "exec",
      pods[0].metadata.name,
      "--",
      "bun",
      "-e",
      "await Bun.write('/work/saved.txt','off-node saved bytes')",
    ]);
    const response = await request(`/v1/workspaces/${workspace.workspaceId}/preserve`, {
      method: "POST",
      headers: { "idempotency-key": identity },
      body: "{}",
    });
    const result = (await response.json()) as { checkpoint: { id: string }; operation: { id: string } };
    if (response.status !== 202) throw new Error("Checkpoint admission failed.");
    await waitFor(
      async () => {
        const checkpoint = (await (await request(`/v1/checkpoints/${result.checkpoint.id}`)).json()) as {
          state: string;
        };
        return checkpoint.state === "ready";
      },
      30_000,
      "checkpoint publication",
    );
    return result.checkpoint.id;
  }
} catch (error) {
  if (f && failureNamespace) {
    const operation = failureOperation ? await f.currentStore()?.getOperation(failureOperation) : null;
    if (operation?.kind === "restore") await recoveryDiagnostic(f, failureNamespace).catch(console.error);
    await managedDiagnostics(f, failureNamespace, failureOperation);
  }
  throw error;
} finally {
  await f?.close();
  await storage.close();
}
