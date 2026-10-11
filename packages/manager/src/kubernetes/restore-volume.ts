import type { OffNodeBackupReceipt } from "@pstdio/pocketcoder-db/off-node";
import {
  captureTermination,
  deleteResource,
  hasMatchingKubernetesTermination,
  type KubernetesEvidenceResource,
  readTerminationEvidence,
  waitForDeletion,
} from "@pstdio/pocketcoder-drivers";
import { RestoreResult } from "../backup/restore-state";
import type { Account, ManagerStore } from "../database/store";
import type { kube } from "./command";
import { restoredVolumeName, restoreJobName, restoreManifests } from "./restore-manifests";

type Operation = NonNullable<Awaited<ReturnType<ManagerStore["getOperation"]>>>;
export function restoreVolume(command: typeof kube) {
  async function owned(account: Account, operationId: string, kind: string, name: string) {
    const prior = await command(["-n", account.namespace, "get", kind, name, "--ignore-not-found", "-o", "json"]);
    if (!prior) return null;
    const resource = JSON.parse(prior);
    if (
      resource.metadata.labels?.["pocketcoder.dev/account"] !== account.id ||
      resource.metadata.labels?.["pocketcoder.dev/restore"] !== operationId
    )
      throw new Error("Restore resource identity differs.");
    return resource;
  }
  async function removeJob(account: Account, operationId: string, store: ManagerStore) {
    const name = restoreJobName(operationId);
    const operation = await store.getOperation(operationId);
    const uid = operation?.computeProof?.restoreJobUid;
    if (typeof uid !== "string") throw new Error("Restore Job identity is missing.");
    const run = (args: string[], input?: string) => command(["-n", account.namespace, ...args], input);
    await captureTermination(run, name, 10, uid, account.namespace);
    const proof = await readTerminationEvidence(run, name, uid);
    if (!proof) throw new Error("Restore job termination proof is missing.");
    await store.saveComputeProof(operationId, { ...operation?.computeProof, restoreJobTermination: proof });
    await deleteResource(run, account.namespace, "jobs", name, uid);
    await waitForDeletion(run, "job", name, uid);
  }
  async function prepareVolume(account: Account, operation: Operation) {
    const volumeName = restoredVolumeName(operation.id);
    const pvc = await owned(account, operation.id, "pvc", volumeName);
    if (!pvc) {
      const inventory = JSON.parse(await command(["-n", account.namespace, "get", "pvc", "-o", "json"]));
      if (inventory.items.length >= 2) throw new Error("Account restore volume limit reached.");
    }
    const saved = operation.computeProof?.targetVolume as { uid: string } | undefined;
    if (saved && pvc?.metadata.uid !== saved.uid) throw new Error("Restore volume identity differs.");
  }
  async function saveResult(
    account: Account,
    operation: Operation,
    receipt: OffNodeBackupReceipt,
    store: ManagerStore,
  ) {
    const name = restoreJobName(operation.id);
    const current = await store.getOperation(operation.id);
    const job = await owned(account, operation.id, "job", name);
    if (!job || job.metadata.uid !== current?.computeProof?.restoreJobUid)
      throw new Error("Restore Job identity differs.");
    const result = RestoreResult.parse(
      JSON.parse(await command(["-n", account.namespace, "logs", `job/${name}`, "-c", "restore"])),
    );
    if (result.recovery.snapshotId !== receipt.snapshotId) throw new Error("Restored snapshot identity differs.");
    const pods = JSON.parse(
      await command(["-n", account.namespace, "get", "pods", "-l", `job-name=${name}`, "-o", "json"]),
    );
    if (
      pods.items.some(
        (pod: { metadata: { ownerReferences?: { kind: string; uid: string }[] } }) =>
          !pod.metadata.ownerReferences?.some((owner) => owner.kind === "Job" && owner.uid === job.metadata.uid),
      )
    )
      throw new Error("Restore Pod identity differs.");
    const names = new Set(pods.items.map((pod: { spec: { nodeName?: string } }) => pod.spec.nodeName));
    if (names.size !== 1 || ![...names][0]) throw new Error("Restore placement is uncertain.");
    const nodeName = [...names][0] as string;
    const node = JSON.parse(await command(["get", "node", nodeName, "-o", "json"]));
    if (!node.metadata.uid || !node.spec.providerID) throw new Error("Restore node identity is missing.");
    await store.saveComputeProof(operation.id, {
      ...current?.computeProof,
      restoreResult: result,
      restorePlacement: {
        name: nodeName,
        uid: node.metadata.uid,
        providerID: node.spec.providerID,
      },
    });
  }
  async function adoptJob(
    account: Account,
    operation: Operation,
    store: ManagerStore,
    priorJob: KubernetesEvidenceResource | null,
  ) {
    const expectedUid = operation.computeProof?.restoreJobUid;
    if (!priorJob && expectedUid && operation.computeProof?.restoreJobFailedUid === expectedUid) {
      await retireFailedJob(operation, store);
      return;
    }
    if (expectedUid && priorJob?.metadata.uid !== expectedUid) throw new Error("Restore Job identity differs.");
    if (priorJob)
      await store.saveComputeProof(operation.id, { ...operation.computeProof, restoreJobUid: priorJob.metadata.uid });
    if (priorJob?.status?.failed) {
      const current = await store.getOperation(operation.id);
      await store.saveComputeProof(operation.id, {
        ...current?.computeProof,
        restoreJobFailedUid: priorJob.metadata.uid,
      });
      await removeJob(account, operation.id, store);
      const failed = await store.getOperation(operation.id);
      if (!failed) throw new Error("Restore operation is missing.");
      await retireFailedJob(failed, store);
      throw new Error("Restore job failed; its owned compute was cleaned and will retry.");
    }
  }
  async function retireFailedJob(operation: Operation, store: ManagerStore) {
    const proof = operation.computeProof ?? {};
    if (
      typeof proof.restoreJobUid !== "string" ||
      !proof.restoreJobTermination ||
      !hasMatchingKubernetesTermination(
        { jobUid: proof.restoreJobUid },
        proof.restoreJobTermination as Record<string, unknown>,
      )
    )
      throw new Error("Failed restore Job termination identity is uncertain.");
    const prior = proof.restoreFailedJobs;
    await store.saveComputeProof(operation.id, {
      ...proof,
      restoreFailedJobs: [...(Array.isArray(prior) ? prior : []), proof.restoreJobTermination],
      restoreJobUid: null,
      restoreJobFailedUid: null,
      restoreJobTermination: null,
    });
  }
  async function applyResources(
    account: Account,
    operation: Operation,
    receipt: OffNodeBackupReceipt,
    store: ManagerStore,
    priorJob: unknown,
  ) {
    const name = restoreJobName(operation.id);
    const volumeName = restoredVolumeName(operation.id);
    for (const resource of restoreManifests(account, operation.id, receipt)) {
      if (resource.kind === "Job" && priorJob) continue;
      await command(
        ["apply", "--server-side", "--field-manager=pocketcoder-manager", "-f", "-"],
        JSON.stringify(resource),
      );
      if (resource.kind === "Job") {
        const job = await owned(account, operation.id, "job", name);
        if (!job?.metadata.uid) throw new Error("Restore Job identity is missing.");
        const current = await store.getOperation(operation.id);
        await store.saveComputeProof(operation.id, { ...current?.computeProof, restoreJobUid: job.metadata.uid });
      }
      if (resource.kind === "PersistentVolumeClaim") {
        const pvc = await owned(account, operation.id, "pvc", volumeName);
        if (!pvc?.metadata.uid) throw new Error("Restore volume identity is missing.");
        const current = await store.getOperation(operation.id);
        await store.saveComputeProof(operation.id, {
          ...current?.computeProof,
          targetVolume: { name: volumeName, uid: pvc.metadata.uid },
        });
      }
    }
  }
  return async (account: Account, operation: Operation, receipt: OffNodeBackupReceipt, store: ManagerStore) => {
    const name = restoreJobName(operation.id);
    const volumeName = restoredVolumeName(operation.id);
    await prepareVolume(account, operation);
    const priorJob = await owned(account, operation.id, "job", name);
    if (!priorJob && operation.computeProof?.restoreResult) {
      const { restoreJobUid, restoreJobTermination } = operation.computeProof;
      if (
        typeof restoreJobUid !== "string" ||
        !restoreJobTermination ||
        !hasMatchingKubernetesTermination({ jobUid: restoreJobUid }, restoreJobTermination as Record<string, unknown>)
      )
        throw new Error("Completed restore Job termination identity is uncertain.");
      return volumeName;
    }
    await adoptJob(account, operation, store, priorJob);
    await applyResources(account, operation, receipt, store, priorJob);
    await command(["-n", account.namespace, "wait", "--for=condition=complete", `job/${name}`, "--timeout=120s"]);
    await saveResult(account, operation, receipt, store);
    await removeJob(account, operation.id, store);
    return volumeName;
  };
}
