import { isDeepStrictEqual } from "node:util";
import type { ManagerStore } from "../database/store";
import type { KubernetesAccounts } from "../kubernetes/accounts";
import { UpgradeSchema } from "./releases";

type Operation = NonNullable<Awaited<ReturnType<ManagerStore["getOperation"]>>>;
export async function reconcileUpgradeRestore(store: ManagerStore, provider: KubernetesAccounts, admitted: Operation) {
  let operation = admitted;
  const upgrade = UpgradeSchema.parse(operation.upgrade);
  const backup = await store.getBackup(operation.id);
  if (!backup) throw new Error("Upgrade recovery backup is missing.");
  let account = await store.getAccount(operation.accountId);
  if (!account) throw new Error("Upgrade recovery account is missing.");
  const refresh = async () => {
    const current = await store.getOperation(operation.id);
    if (!current) throw new Error("Upgrade recovery operation is missing.");
    operation = current;
  };
  if (operation.phase === "restore") {
    const proof = operation.computeProof ?? {};
    const sourceCompute = proof.sourceCompute ?? {
      runtime: proof.runtime,
      backups: proof.backups,
      controllerTermination: proof.controllerTermination,
    };
    const sourceVolume = await provider.backup.proveSourceStopped(
      account,
      sourceCompute as Record<string, unknown>,
      operation.id,
    );
    if (proof.sourceVolume && !isDeepStrictEqual(proof.sourceVolume, sourceVolume))
      throw new Error("Upgrade source volume identity differs.");
    await store.saveComputeProof(operation.id, { ...proof, sourceCompute, sourceVolume });
    await refresh();
    // The verified backup predates the upgrade. Its original image understands this data format.
    await store.installUpgradePlan(operation.id);
    account = await store.getAccount(account.id);
    if (!account) throw new Error("Upgrade recovery account is missing.");
    const volume = await provider.backup.restoreVolume(account, operation, backup.receipt, store);
    await store.markRestorePrepared(operation.id, volume);
    await refresh();
    account = await store.getAccount(account.id);
    if (!account) throw new Error("Upgrade recovery account is missing.");
  }
  if (operation.phase === "recover") {
    await provider.backup.recover(account, operation, backup.receipt);
    await store.setOperationPhase(operation.id, "open");
    await refresh();
  }
  if (operation.phase !== "open") throw new Error("Upgrade restore is not ready for admission.");
  await provider.backup.open(account, operation, backup.receipt);
  await provider.upgrade.format(account, upgrade.source);
  await provider.lifecycle.perform(account, "resume", upgrade.resumeId);
  await store.finishAccount(account.id, operation.id);
}
