import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { WorkspaceResourceSchema } from "@pstdio/pocketcoder-contracts";
import { BackupRuntimeProofSchema } from "@pstdio/pocketcoder-db/off-node";
import {
  hasMatchingKubernetesTermination,
  type KubernetesEvidenceResource,
  podHasStopped,
} from "@pstdio/pocketcoder-drivers";
import { waitFor } from "./local-process";
import { managedInterruptionFixture } from "./managed-interruption-fixture";

type Fixture = Awaited<ReturnType<typeof managedInterruptionFixture>>;
type Admitted = { account: { id: string; namespace: string }; operation: { id: string } };
type Operation = {
  id: string;
  state: string;
  phase: string;
  errorCode: string | null;
  computeProof: Record<string, unknown> | null;
};
let fixture: Fixture | undefined;
let namespace: string | undefined;
let operationId: string | undefined;

function require(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function post(f: Fixture, path: string, key: string, body?: unknown) {
  const response = await f.request(path, {
    method: "POST",
    headers: { "idempotency-key": key },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  require(response.status === 202, `Manager admission ${path}: ${response.status}`);
  return (await response.json()) as Admitted;
}
async function operation(f: Fixture, id: string) {
  const response = await f.request(`/v1/operations/${id}`);
  require(response.ok, "Manager operation read failed");
  return (await response.json()) as Operation;
}
async function inventory(f: Fixture, ns: string, resource: string) {
  return JSON.parse(await f.cluster.kube(["-n", ns, "get", resource, "-o", "json"]))
    .items as KubernetesEvidenceResource[];
}
async function snapshot(f: Fixture, accountId: string, id: string) {
  return f.readStore(async (store) => {
    const account = await store.getAccount(accountId);
    const operation = await store.getOperation(id);
    require(account && operation, "Durable manager account or operation is missing");
    return { account, operation };
  });
}
async function crashAt(
  f: Fixture,
  id: string,
  file: string,
  after: string,
  statement: string,
  allowedPhases: string[],
  ns: string,
  timeout: number,
) {
  const stopped = await f.arm(file, after, statement);
  const deadline = Date.now() + timeout;
  const reconcile = (async () => {
    while (Date.now() < deadline) {
      await f.reconcile();
      const current = await operation(f, id);
      console.log(
        JSON.stringify({
          reconciliationBeforeBarrier: {
            id: current.id,
            phase: current.phase,
            state: current.state,
            errorCode: current.errorCode,
          },
        }),
      );
      require(current.state !== "succeeded", "Manager completed without reaching its durable crash boundary");
      require(allowedPhases.includes(current.phase), "Manager advanced past its durable crash boundary");
      await Bun.sleep(250);
    }
    throw new Error("Manager durable crash boundary timed out");
  })();
  // SIGKILL rejects the outstanding real reconciliation request; observe it before killing the child.
  void reconcile.catch(() => {});
  await Promise.race([stopped(Math.max(1, deadline - Date.now())), reconcile]);
  const pods = await inventory(f, ns, "pods");
  const jobs = await inventory(f, ns, "jobs");
  require(pods.length === 0 && jobs.length === 0, "Actual source or restore compute remains at the crash boundary");
  console.log(JSON.stringify({ absentComputeBeforeKill: { namespace: ns, pods: pods.length, jobs: jobs.length } }));
  await f.kill();
}
async function complete(f: Fixture, id: string, timeout: number) {
  await waitFor(
    async () => {
      await f.reconcile();
      return (await operation(f, id)).state === "succeeded";
    },
    timeout,
    "same manager operation after SIGKILL",
  );
}

async function runningWorkspace(url: string, token: string, template: string) {
  const request = (path: string, input: RequestInit = {}) =>
    fetch(`${url}${path}`, {
      ...input,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...input.headers },
    });
  const externalId = randomUUID();
  const response = await request("/v1/workspaces", {
    method: "POST",
    headers: { "idempotency-key": externalId },
    body: JSON.stringify({ external_id: externalId, template: { name: template } }),
  });
  require(response.ok, "Actual active workspace admission failed");
  const created = WorkspaceResourceSchema.parse(await response.json());
  await waitFor(
    async () => {
      const response = await request(`/v1/workspaces/${created.id}`);
      require(response.ok, "Actual active workspace read failed");
      const workspace = WorkspaceResourceSchema.parse(await response.json());
      require(!["succeeded", "failed", "canceled", "expired"].includes(
        workspace.state,
      ), "Active workspace ended before readiness");
      return workspace.state === "ready";
    },
    120_000,
    "actual active workspace readiness",
  );
  return { workspaceId: created.id };
}

try {
  fixture = await managedInterruptionFixture();
  const f = fixture;
  const created = await post(f, "/v1/accounts", "interruption-account", { name: "manager-interruption" });
  const accountId = created.account.id;
  namespace = created.account.namespace;
  await complete(f, created.operation.id, 120_000);
  const ownerResponse = await f.request(`/v1/accounts/${accountId}/owner`, {
    method: "POST",
    body: JSON.stringify({ request_id: randomUUID(), expires_at: new Date(Date.now() + 20 * 60_000).toISOString() }),
  });
  require(ownerResponse.ok, "Finite account owner creation failed");
  const owner = (await ownerResponse.json()) as { token: string };
  const url = await f.connect(namespace);
  const template = await f.cluster.echoTemplate(f.workspace.image);
  template.metadata.name = "interruption-active";
  template.spec.resources.ephemeralStorage = "128Mi";
  const imported = await fetch(`${url}/v1/templates`, {
    method: "POST",
    headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
    body: JSON.stringify({ manifest: template }),
  });
  require(imported.ok, "Actual echo template import failed");
  const active = await runningWorkspace(url, owner.token, template.metadata.name);
  const livePods = await inventory(f, namespace, "pods");
  const controllers = livePods.filter((pod) => pod.metadata.labels?.["pocketcoder.dev/role"] === "controller");
  require(controllers.length === 1 && controllers[0]?.metadata.uid, "Actual live controller UID is missing");
  const controllerUid = controllers[0].metadata.uid;
  const liveJobs = await inventory(f, namespace, "jobs");
  const activeJob = liveJobs.find((job) => job.metadata.labels?.["pocketcoder.workspace"] === active.workspaceId);
  require(activeJob?.metadata.uid, "Actual active Job UID is missing");
  const activePod = livePods.find((pod) => pod.metadata.labels?.["pocketcoder.workspace"] === active.workspaceId);
  require(activePod?.metadata.uid &&
    activePod.spec.nodeName &&
    activePod.metadata.ownerReferences?.some((owner) => owner.kind === "Job" && owner.uid === activeJob.metadata.uid) &&
    activePod.status?.containerStatuses?.length === activePod.spec.containers?.length &&
    activePod.status?.containerStatuses?.length &&
    activePod.status.containerStatuses.every(
      (container) => container.containerID && "running" in container.state,
    ), "Actual bound running active Pod and owner Job identity are missing");
  const sourcePvc = (await inventory(f, namespace, "pvc"))[0];
  require(sourcePvc?.metadata.uid && sourcePvc.metadata.name, "Actual source PVC identity is missing");
  const backup = await post(f, `/v1/accounts/${accountId}/backups`, "interruption-backup");
  await complete(f, backup.operation.id, 120_000);
  const versions = await f.storage.storage.storage.versions(`accounts/${accountId}/backups/`);
  require(versions.length > 0, "Actual backup object version is missing");

  const suspended = await post(f, `/v1/accounts/${accountId}/suspend`, "interruption-suspend");
  operationId = suspended.operation.id;
  await crashAt(
    f,
    suspended.operation.id,
    "/accounts/reconcile-suspend.ts",
    "await provider.stopController.stop",
    "await store.finishAccount",
    ["controller", "scale"],
    namespace,
    120_000,
  );
  const killedSuspend = await snapshot(f, accountId, suspended.operation.id);
  require(killedSuspend.operation.phase === "scale" &&
    killedSuspend.operation.state !== "succeeded", "Suspend completion advanced before SIGKILL");
  require(killedSuspend.account.state === "suspending", "Account completed suspension before SIGKILL");
  require(killedSuspend.account.volumeName === sourcePvc.metadata.name, "Suspension changed the source volume");
  const controllerProof = killedSuspend.operation.computeProof?.controllerTermination as KubernetesEvidenceResource[];
  require(controllerProof?.length === 1 &&
    controllerProof.every(podHasStopped), "Durable actual controller exits are missing");
  require(controllerProof[0]?.metadata.uid ===
    controllerUid, "Durable controller exit UID differs from the actual source");
  const backupProofs = killedSuspend.operation.computeProof?.backups as Record<string, unknown>;
  const backupProof = BackupRuntimeProofSchema.parse(backupProofs[backup.operation.id]);
  const activeProof = backupProof.runtimes.find((runtime) => runtime.identity.id === active.workspaceId);
  require(activeProof &&
    activeProof.identity.ref.jobUid === activeJob.metadata.uid, "Archived active Job identity is missing");
  require(hasMatchingKubernetesTermination(
    activeProof.identity.ref,
    activeProof.termination,
  ), "Durable actual active runtime exit proof is missing");
  const activeExits = activeProof.termination.pods as KubernetesEvidenceResource[];
  require(activeExits.some(
    (pod) =>
      pod.metadata.uid === activePod.metadata.uid &&
      podHasStopped(pod) &&
      pod.metadata.ownerReferences?.some((owner) => owner.kind === "Job" && owner.uid === activeJob.metadata.uid),
  ), "Captured running active Pod has no stopped owner-matching durable proof");
  console.log(JSON.stringify({ durableSuspendAfterKill: killedSuspend }));
  await f.start();
  const sameSuspend = await post(f, `/v1/accounts/${accountId}/suspend`, "interruption-suspend");
  require(sameSuspend.operation.id === suspended.operation.id, "Suspend restart admitted a second operation");
  await complete(f, suspended.operation.id, 120_000);
  const completedSuspend = await operation(f, suspended.operation.id);
  require(isDeepStrictEqual(
    completedSuspend.computeProof,
    killedSuspend.operation.computeProof,
  ), "Suspend restart changed saved exit proof");
  require((await inventory(f, namespace, "pods")).length === 0, "Restart recreated source Pods");

  const restored = await post(f, `/v1/accounts/${accountId}/restore`, "interruption-restore", {
    backup_id: backup.operation.id,
  });
  operationId = restored.operation.id;
  await crashAt(
    f,
    restored.operation.id,
    "/backup/reconcile.ts",
    "const volume = await provider.backup.restoreVolume",
    "await store.markRestorePrepared",
    ["fence", "restore"],
    namespace,
    180_000,
  );
  const killedRestore = await snapshot(f, accountId, restored.operation.id);
  require(killedRestore.operation.phase === "restore" &&
    killedRestore.operation.state !== "succeeded", "Restore phase advanced before SIGKILL");
  require(killedRestore.account.state === "restoring" &&
    killedRestore.account.volumeName === sourcePvc.metadata.name, "Restore volume handoff happened before SIGKILL");
  const proof = killedRestore.operation.computeProof;
  const result = proof?.restoreResult as { recovery?: { snapshotId?: string } };
  require(result?.recovery?.snapshotId === backupProof.snapshotId, "Durable actual restore result is missing");
  require(typeof proof?.restoreJobUid === "string", "Durable actual restore Job UID is missing");
  require(hasMatchingKubernetesTermination(
    { jobUid: proof.restoreJobUid },
    proof.restoreJobTermination as Record<string, unknown>,
  ), "Durable actual restore Job exits are missing");
  const target = proof.targetVolume as { name: string; uid: string };
  const volumes = await inventory(f, namespace, "pvc");
  require(volumes.length === 2, "Restore did not retain exactly the original and fresh PVCs");
  require(volumes.some(
    (pvc) => pvc.metadata.name === target.name && pvc.metadata.uid === target.uid,
  ), "Durable restore target PVC identity differs");
  console.log(JSON.stringify({ durableRestoreAfterKill: killedRestore, sourcePvc: sourcePvc.metadata, target }));
  await f.start();
  const sameRestore = await post(f, `/v1/accounts/${accountId}/restore`, "interruption-restore", {
    backup_id: backup.operation.id,
  });
  require(sameRestore.operation.id === restored.operation.id, "Restore restart admitted a second operation");
  await complete(f, restored.operation.id, 180_000);
  await f.stop();
  const completed = await snapshot(f, accountId, restored.operation.id);
  require(completed.operation.phase === "complete" &&
    completed.account.state === "ready", "Restored account did not complete");
  require(completed.account.volumeName === target.name, "Atomic phase and target volume handoff did not finish");
  require(isDeepStrictEqual(
    completed.operation.computeProof,
    proof,
  ), "Restore restart replaced durable result or exit proof");
  const finalVolumes = await inventory(f, namespace, "pvc");
  require(finalVolumes.length === 2 &&
    finalVolumes.some((pvc) => pvc.metadata.uid === sourcePvc.metadata.uid) &&
    finalVolumes.some((pvc) => pvc.metadata.uid === target.uid), "Restart replaced or added a PVC");
  require(isDeepStrictEqual(
    await f.storage.storage.storage.versions(`accounts/${accountId}/backups/`),
    versions,
  ), "Restart copied or replaced the backup object");
  await f.start();
  const terminalRetry = await post(f, `/v1/accounts/${accountId}/restore`, "interruption-restore", {
    backup_id: backup.operation.id,
  });
  require(terminalRetry.operation.id === restored.operation.id, "Terminal restore retry duplicated admission");
  await f.reconcile();
  console.log(
    JSON.stringify({
      result: "passed",
      accountId,
      suspend: suspended.operation.id,
      restore: restored.operation.id,
      sourcePvcUid: sourcePvc.metadata.uid,
      restoredPvcUid: target.uid,
      managerKills: 2,
      runtime: "local Kind pc-runc",
    }),
  );
} catch (error) {
  console.error(error);
  console.error(JSON.stringify({ failedOperation: operationId, namespace }));
  if (fixture && namespace) {
    for (const resource of ["pods", "jobs", "events"]) {
      console.error(await fixture.cluster.kube(["-n", namespace, "get", resource, "-o", "json"]).catch(String));
    }
  }
  throw error;
} finally {
  await fixture?.close();
  console.log("Owned manager children, forwarding process, Kind nodes, S3 fixture, and controller tag closed.");
}
