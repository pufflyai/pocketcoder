import { isDeepStrictEqual } from "node:util";
import type { ManagerStore } from "../database/store";
import type { KubernetesAccounts } from "../kubernetes/accounts";

type Operation = NonNullable<Awaited<ReturnType<ManagerStore["getOperation"]>>>;
export async function reconcileBackup(store: ManagerStore, provider: KubernetesAccounts, operation: Operation) {
  const account = await store.getAccount(operation.accountId);
  if (!account) throw new Error("Account missing.");
  const receipt = await provider.backup.capture(account, operation.id);
  await store.saveBackup(operation.id, receipt);
}

export async function reconcileRestore(store: ManagerStore, provider: KubernetesAccounts, admitted: Operation) {
  const backup = admitted.backupId ? await store.getBackup(admitted.backupId) : null;
  if (!backup || backup.accountId !== admitted.accountId) throw new Error("Restore backup identity differs.");
  let operation = admitted;
  let account = await store.getAccount(admitted.accountId);
  if (!account) throw new Error("Account missing.");
  if (operation.phase === "fence") {
    const sourceCompute = await store.sourceComputeProof(account.id);
    const sourceVolume = await provider.backup.proveSourceStopped(account, sourceCompute);
    await store.saveComputeProof(operation.id, { ...operation.computeProof, sourceCompute, sourceVolume });
    await store.setOperationPhase(operation.id, "restore");
  }
  operation = (await store.getOperation(operation.id)) ?? operation;
  if (operation.phase === "restore") {
    const sourceCompute = operation.computeProof?.sourceCompute;
    if (!sourceCompute || typeof sourceCompute !== "object") throw new Error("Source compute proof is missing.");
    const sourceVolume = await provider.backup.proveSourceStopped(
      account,
      sourceCompute as Record<string, unknown>,
      operation.id,
    );
    if (!isDeepStrictEqual(sourceVolume, operation.computeProof?.sourceVolume))
      throw new Error("Source volume identity differs.");
    const volume = await provider.backup.restoreVolume(account, operation, backup.receipt, store);
    await store.markRestorePrepared(operation.id, volume);
  }
  operation = (await store.getOperation(operation.id)) ?? operation;
  account = (await store.getAccount(account.id)) ?? account;
  if (operation.phase === "recover") {
    await provider.backup.recover(account, operation, backup.receipt);
    await store.setOperationPhase(operation.id, "open");
  }
  operation = (await store.getOperation(operation.id)) ?? operation;
  if (operation.phase !== "open") throw new Error("Restore phase is not ready for admission.");
  await provider.backup.open(account, operation, backup.receipt);
  await provider.lifecycle.perform(account, "resume", operation.id);
  await store.finishAccount(account.id, operation.id);
}
