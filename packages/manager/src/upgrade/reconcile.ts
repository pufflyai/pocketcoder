import type { ManagerStore } from "../database/store";
import type { KubernetesAccounts } from "../kubernetes/accounts";
import { UpgradeSchema } from "./releases";
import { reconcileUpgradeRestore } from "./restore";

type Operation = NonNullable<Awaited<ReturnType<ManagerStore["getOperation"]>>>;
export async function reconcileUpgrade(store: ManagerStore, provider: KubernetesAccounts, admitted: Operation) {
  let operation = admitted;
  let account = await store.getAccount(operation.accountId);
  if (!account) throw new Error("Upgrade account is missing.");
  const upgrade = UpgradeSchema.parse(operation.upgrade);
  const refresh = async () => {
    const current = await store.getOperation(operation.id);
    if (!current) throw new Error("Upgrade operation is missing.");
    operation = current;
  };
  if (operation.phase === "fence") {
    await provider.upgrade.format(account, upgrade.source);
    await provider.stopController.prepare(account, operation, store);
    const result = await provider.lifecycle.perform(account, "suspend", upgrade.suspendId);
    if (!result.compute_proof) throw new Error("Upgrade runtime termination proof is missing.");
    await refresh();
    await store.saveComputeProof(operation.id, { ...operation.computeProof, runtime: result.compute_proof });
    await store.setOperationPhase(operation.id, "capture");
    await refresh();
  }
  if (operation.phase === "capture") {
    const receipt = await provider.backup.capture(account, operation.id);
    await store.saveBackup(operation.id, receipt);
    await refresh();
  }
  if (operation.phase === "scale") {
    const backup = await store.getBackup(operation.id);
    if (!backup) throw new Error("Upgrade backup is missing.");
    if (!operation.computeProof?.backups) {
      const proof = await provider.backup.runtimeProof(account, backup.receipt);
      await store.saveComputeProof(operation.id, {
        ...operation.computeProof,
        backups: { [backup.id]: proof },
        sourceVolumeName: account.volumeName,
      });
      await refresh();
    }
    await provider.stopController.stop(account, operation, store);
    await store.setOperationPhase(operation.id, "install");
    await refresh();
  }
  if (operation.phase === "controller") {
    // Failed replacements stayed fenced. Retain their exits before rollback, forward fix or restore.
    await provider.stopController.prepare(account, operation, store);
    await refresh();
    await provider.stopController.stop(account, operation, store);
    await store.setOperationPhase(operation.id, upgrade.mode === "restore" ? "restore" : "install");
    await refresh();
  }
  if (upgrade.mode === "restore") return reconcileUpgradeRestore(store, provider, operation);
  if (operation.phase === "install") {
    await provider.upgrade.install(
      account,
      upgrade.target,
      `${operation.id}:${upgrade.mode}:${upgrade.target.version}`,
    );
    await store.setOperationPhase(operation.id, "verify");
    await refresh();
  }
  if (operation.phase === "verify") {
    await provider.upgrade.verify(account, upgrade.target);
    await store.installUpgradePlan(operation.id);
    await store.setOperationPhase(operation.id, "open");
    await refresh();
  }
  if (operation.phase !== "open") throw new Error("Upgrade is not ready for admission.");
  account = await store.getAccount(account.id);
  if (!account) throw new Error("Upgrade account is missing.");
  await provider.upgrade.format(account, upgrade.target);
  await provider.lifecycle.perform(account, "resume", upgrade.resumeId);
  await store.finishAccount(account.id, operation.id);
}
