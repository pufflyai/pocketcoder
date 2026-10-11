import { randomUUID } from "node:crypto";
import { cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHarnessWorkspace } from "./contract";
import { waitFor } from "./local-process";
import { exercisePurgeFaults } from "./managed-purge-fault-flow";
import { managedPurgeFixture } from "./managed-purge-fixture";
import { verifyManagedPurgeDrain } from "./managed-purge-proof";

const fixture = await managedPurgeFixture({ physicalStorage: true });
let failure: unknown;
let cleanupFailure: unknown;
try {
  const requestId = randomUUID();
  const created = await fixture.request("/v1/accounts", {
    method: "POST",
    headers: { "idempotency-key": requestId },
    body: JSON.stringify({ name: "physical purge" }),
  });
  if (created.status !== 202) throw new Error(`Account admission failed: ${created.status}`);
  const { account, operation } = (await created.json()) as {
    account: { id: string; namespace: string };
    operation: { id: string };
  };
  const status = async (id: string) =>
    (await (await fixture.request(`/v1/operations/${id}`)).json()) as { state: string };
  await fixture.reconcile();
  if ((await status(operation.id)).state !== "succeeded")
    throw new Error("Actual account provisioning remains pending.");
  const owner = await fixture.request(`/v1/accounts/${account.id}/owner`, {
    method: "POST",
    body: JSON.stringify({ request_id: randomUUID(), expires_at: new Date(Date.now() + 20 * 60_000).toISOString() }),
  });
  if (owner.status !== 200) throw new Error(`Actual owner issuance failed: ${owner.status}`);
  const issued = (await owner.json()) as { token: string; key: { id: string } };
  const controllers = JSON.parse(
    await fixture.cluster.kube([
      "-n",
      account.namespace,
      "get",
      "pods",
      "-l",
      "pocketcoder.dev/role=controller",
      "-o",
      "json",
    ]),
  ).items;
  if (controllers.length !== 1) throw new Error("Actual account controller identity is missing.");
  console.log(
    JSON.stringify({
      purgeOwnerIssued: { accountId: account.id, keyId: issued.key.id, controllerUid: controllers[0].metadata.uid },
    }),
  );
  const url = await fixture.connect(account.namespace);
  if (!fixture.workspaceImage) throw new Error("Actual runtime fixture image is missing.");
  const template = await fixture.cluster.echoTemplate(fixture.workspaceImage);
  template.metadata.name = "purge-active";
  template.spec.resources.ephemeralStorage = "128Mi";
  const imported = await fetch(`${url}/v1/templates`, {
    method: "POST",
    signal: AbortSignal.timeout(5000),
    headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" },
    body: JSON.stringify({ manifest: template }),
  });
  if (!imported.ok) throw new Error("Actual runtime template import failed.");
  const active = await createHarnessWorkspace({ baseUrl: url, key: issued.token, template: template.metadata.name });
  const jobs = JSON.parse(
    await fixture.cluster.kube([
      "-n",
      account.namespace,
      "get",
      "jobs",
      "-l",
      `pocketcoder.workspace=${active.workspaceId}`,
      "-o",
      "json",
    ]),
  ).items;
  const pods = JSON.parse(
    await fixture.cluster.kube([
      "-n",
      account.namespace,
      "get",
      "pods",
      "-l",
      `pocketcoder.workspace=${active.workspaceId}`,
      "-o",
      "json",
    ]),
  ).items;
  if (
    jobs.length !== 1 ||
    pods.length !== 1 ||
    pods[0].status.phase !== "Running" ||
    !pods[0].metadata.ownerReferences.some((r: { uid: string }) => r.uid === jobs[0].metadata.uid)
  )
    throw new Error("Actual active runtime identity is missing.");
  console.log(
    JSON.stringify({
      activePurgeRuntime: {
        workspaceId: active.workspaceId,
        jobUid: jobs[0].metadata.uid,
        podUid: pods[0].metadata.uid,
      },
    }),
  );
  await fixture.cluster.kube([
    "-n",
    account.namespace,
    "exec",
    "deployment/controller",
    "-c",
    "controller",
    "--",
    "bun",
    "-e",
    "await Bun.write('/private/purge-marker','actual retained purge bytes')",
  ]);
  const backupResponse = await fixture.request(`/v1/accounts/${account.id}/backups`, {
    method: "POST",
    headers: { "idempotency-key": randomUUID() },
  });
  if (backupResponse.status !== 202) throw new Error("Actual backup admission failed.");
  const backup = (await backupResponse.json()) as { operation: { id: string } };
  await fixture.reconcile();
  if ((await status(backup.operation.id)).state !== "succeeded")
    throw new Error("Actual encrypted backup remains pending.");
  const prefix = `accounts/${account.id}/`;
  if (!(await fixture.storage.storage.storage.versions(prefix)).length)
    throw new Error("Actual retained object versions are missing.");
  const claim = JSON.parse(
    await fixture.cluster.kube(["-n", account.namespace, "get", "pvc", "controller-data", "-o", "json"]),
  );
  const pv = JSON.parse(await fixture.cluster.kube(["get", "pv", claim.spec.volumeName, "-o", "json"]));
  if (
    pv.spec.claimRef.uid !== claim.metadata.uid ||
    pv.spec.claimRef.namespace !== account.namespace ||
    !pv.spec.hostPath?.path
  )
    throw new Error("Actual owned retained volume binding differs.");
  const nodeName = pv.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values[0];
  const node = JSON.parse(await fixture.cluster.kube(["get", "node", nodeName, "-o", "json"]));
  const containerId = await fixture.cluster.run(["docker", "inspect", "--format", "{{.Id}}", nodeName]);
  const path = pv.spec.hostPath.path as string;
  await fixture.cluster.run(["docker", "exec", containerId, "test", "-f", `${path}/purge-marker`]);
  console.log(
    JSON.stringify({
      retainedPurgeStorage: {
        claimUid: claim.metadata.uid,
        persistentVolumeUid: pv.metadata.uid,
        nodeUid: node.metadata.uid,
        providerId: node.spec.providerID,
        path,
      },
    }),
  );
  await fixture.stopManager();
  const stale = join(fixture.cluster.directory, "stale-manager-data");
  await cp(fixture.directory, stale, { recursive: true });
  await fixture.openManager();
  const admitted = await fixture.request(`/v1/accounts/${account.id}/purge`, {
    method: "POST",
    headers: { "idempotency-key": randomUUID() },
  });
  if (admitted.status !== 202) throw new Error(`Actual purge admission failed: ${admitted.status}`);
  const purge = (await admitted.json()) as { operation: { id: string } };
  console.log(JSON.stringify({ physicalPurgeAdmitted: { accountId: account.id, operationId: purge.operation.id } }));
  let revoked = false;
  await waitFor(
    async () => {
      await fixture.reconcile();
      if (!revoked)
        revoked = await verifyManagedPurgeDrain(fixture, account, purge.operation.id, {
          keyId: issued.key.id,
          controllerUid: controllers[0].metadata.uid,
        });
      return revoked;
    },
    120_000,
    "actual managed private purge drainage",
  );
  if (!revoked) throw new Error("Actual key revocation was not observed before physical deletion.");
  await exercisePurgeFaults(
    fixture,
    account.id,
    purge.operation.id,
    {
      name: nodeName,
      uid: node.metadata.uid,
      providerId: node.spec.providerID,
      containerId,
    },
    path,
  );
  await waitFor(
    async () => {
      await fixture.reconcile();
      return (await status(purge.operation.id)).state === "succeeded";
    },
    120_000,
    "actual managed physical purge completion",
  );
  await fixture.cluster.run(["docker", "exec", containerId, "test", "!", "-e", path]);
  if (await fixture.cluster.kube(["get", "namespace", account.namespace, "--ignore-not-found", "-o", "json"]))
    throw new Error("Purged account namespace remains.");
  for (const kind of ["clusterrole", "clusterrolebinding"])
    if (await fixture.cluster.kube(["get", kind, `${account.namespace}-nodes`, "--ignore-not-found", "-o", "json"]))
      throw new Error("Account-owned cluster authority remains.");
  if (
    (await fixture.storage.storage.storage.versions(prefix)).length ||
    (await fixture.storage.storage.storage.multipart(prefix)).length
  )
    throw new Error("Retained account objects or multipart uploads remain.");
  await fixture.stopManager();
  await rm(fixture.directory, { recursive: true });
  await cp(stale, fixture.directory, { recursive: true });
  await fixture.openManager();
  if ((await status(purge.operation.id)).state !== "succeeded")
    throw new Error("Completed purge replay changed after stale database restore.");
  const replay = await fixture.request("/v1/accounts", {
    method: "POST",
    headers: { "idempotency-key": requestId },
    body: JSON.stringify({ name: "physical purge" }),
  });
  if (replay.status !== 409) throw new Error("Original create request resurrected a purged account.");
  if (((await (await fixture.request("/v1/accounts")).json()) as { items: unknown[] }).items.length)
    throw new Error("Stale account content survived completed replay.");
  console.log(
    JSON.stringify({
      physicalPurgePassed: {
        accountId: account.id,
        operationId: purge.operation.id,
        activeJobUid: jobs[0].metadata.uid,
        activePodUid: pods[0].metadata.uid,
        claimUid: claim.metadata.uid,
        persistentVolumeUid: pv.metadata.uid,
        staleReplay: true,
      },
    }),
  );
} catch (error) {
  failure = error;
} finally {
  try {
    await fixture.close();
  } catch (error) {
    cleanupFailure = error;
  }
}
if (cleanupFailure)
  throw new AggregateError([...(failure ? [failure] : []), cleanupFailure], "Physical purge fixture cleanup failed");
if (failure) throw failure;
